// oxlint-disable-next-line t3code/no-low-value-comments -- the limits of the list are the contract and belong in the header
/**
 * Flightplan OP#1868: fixed deny list for ticket threads.
 *
 * It is hooked in as a Claude Agent SDK `PreToolUse` hook (see `makeClaudeQueryOptions`). A hook deny is
 * decided before the permission mode and before `canUseTool`, so it holds in `auto`, `default`, `acceptEdits`,
 * `bypassPermissions` and after the fallback to `dontAsk`. The auto-mode classifier cannot override it.
 * It applies only to threads the server maps to a ticket (`flightplan-ticket-threads.json`) and can be
 * switched off with `T3CODE_FP_DENYLIST=0`.
 *
 * What it checks
 *  - Bash: every part of a simple chain (`;`, `&&`, `||`, `|`, `&`, newlines, `( )`, backticks) on its own.
 *    Leading `VAR=x`, `env`, `nice`, `ionice`, `timeout N`, `command`, `exec`, `time`, `nohup`, `setsid`,
 *    `stdbuf` are skipped. A literal `cd <dir>` in the chain changes the directory for the parts after it.
 *    `find ... -exec CMD`, `xargs CMD`, `ssh host CMD`, `watch CMD` check CMD as a command of its own.
 *    `sh -c`, `bash -c`, `eval` are parsed once more. The code text of `sh|bash -c`, `eval`, `python -c`,
 *    `node|bun -e|-p`, `perl|ruby -e`, `php -r` is also scanned word by word for the core commands
 *    (at most 64 KB; a longer text is refused).
 *  - Shell writes into protected paths: `>`, `>>`, `&>`, `tee`, `cp`, `mv`, `install`, `ln`, `rsync` (destination),
 *    `sed -i`, `chmod`, `chown`, `touch`, `mkdir`, `truncate`, `dd of=`, `rm`.
 *  - A bare `git push` or `git push origin HEAD` is refused when the hook finds the checked-out branch is main/master.
 *  - Write, Edit, MultiEdit, NotebookEdit: the target path.
 *
 * Limits, stated honestly. This list stops the straight path, not a deliberate way around it.
 *  - Not seen: variables or aliases that hide a command, `$(...)` inside double quotes outside the wrappers above,
 *    base64, a script file (`bash run.sh`, `python x.py`), `git -c alias...`, `gh`/`curl` calls that do the same
 *    remotely, a `cd` inside a subshell that is meant to stay local, symlinks that point into a protected path,
 *    writes by interpreters other than the scanned words (`python -c "open('/etc/x','w')"`).
 *  - Sibling worktrees by full name (`rm -rf /root/.local/state/flightplan/worktrees/op-2-y`) are allowed on purpose;
 *    a pattern directly under an allowed root (`/tmp/*`) is refused.
 *  - The branch for a bare `git push` is read with `git symbolic-ref` at hook time; unknown branch means free.
 *  - The list does not replace a sandbox or a host-level control. Against a misled agent only OP#1845 helps.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

import { readTicketThreadMap } from "./ticketThreads.ts";

export const DENYLIST_ENV = "T3CODE_FP_DENYLIST";

/** On by default for ticket threads. `0` (or `false`) switches it off. */
export function denylistEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DENYLIST_ENV]?.trim().toLowerCase();
  return value !== "0" && value !== "false";
}

export function denyMessage(reason: string): string {
  return `Gesperrt für Ticket-Threads (Flightplan-Sperrliste): ${reason}. Führe das nicht auf anderem Weg aus. Stelle stattdessen eine Rückfrage mit fp-op ask.`;
}

let warnedBrokenMapping = false;

/**
 * True when the switch is on and one of the thread ids (thread, its root) is the thread of a ticket in the
 * server mapping. Free chats have no entry and stay untouched. A mapping file that cannot be parsed turns the
 * list off for every thread; that is logged once per process. A missing file is normal and silent.
 */
export function denylistAppliesToThread(
  ticketThreadsFile: string | undefined,
  threadIds: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (ticketThreadsFile === undefined || !denylistEnabled(env)) return false;
  let raw: string;
  try {
    raw = NodeFS.readFileSync(ticketThreadsFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnBrokenMapping(ticketThreadsFile);
    return false;
  }
  try {
    JSON.parse(raw);
  } catch {
    warnBrokenMapping(ticketThreadsFile);
    return false;
  }
  const known = new Set(
    Object.values(readTicketThreadMap(ticketThreadsFile)).map((r) => r.threadId),
  );
  return threadIds.some((id) => known.has(id));
}

function warnBrokenMapping(file: string): void {
  if (warnedBrokenMapping) return;
  warnedBrokenMapping = true;
  console.warn(
    `[flightplan] OP#1868: ${file} cannot be read; the ticket-thread deny list is off for all threads.`,
  );
}

/** Test hook: allows the one-time warning to fire again. */
export function resetDenylistWarnings(): void {
  warnedBrokenMapping = false;
}

export interface DenylistContext {
  /** Effective directory of the command. Null when unknown. */
  readonly cwd: string | null;
  /** Directory the session started in; the allowed roots for recursive rm follow it, not a `cd`. */
  readonly rootCwd?: string | null;
  readonly home?: string;
  /** Checked-out branch per directory, resolved by the hook. Missing or null means unknown. */
  readonly branchOf?: (dir: string) => string | null | undefined;
  /** Collects the directories where a bare push needs the branch (first pass of the hook). */
  readonly pushDirs?: Set<string>;
}

const RESERVED = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "!",
  "{",
  "}",
  "time",
  "nohup",
  "setsid",
  "builtin",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "su"]);
const SYSTEMCTL_DENY = new Set([
  "start",
  "stop",
  "restart",
  "reload",
  "enable",
  "disable",
  "mask",
  "unmask",
  "daemon-reload",
  "edit",
  "kill",
  "try-restart",
  "reload-or-restart",
  "try-reload-or-restart",
  "daemon-reexec",
  "reenable",
  "isolate",
  "preset",
  "set-default",
  "set-property",
  "poweroff",
  "reboot",
  "halt",
]);
const SYSTEMCTL_VALUE_OPTS = new Set([
  "-H",
  "--host",
  "-M",
  "--machine",
  "-t",
  "--type",
  "-p",
  "--property",
  "-s",
  "--signal",
  "-n",
  "--lines",
  "-o",
  "--output",
  "--root",
  "--state",
  "-T",
]);

const DOCKER_VALUE_OPTS = new Set([
  "-H",
  "--host",
  "-c",
  "--context",
  "--config",
  "-l",
  "--log-level",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
]);
const COMPOSE_VALUE_OPTS = new Set([
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--profile",
  "--env-file",
  "--project-directory",
  "--parallel",
  "--ansi",
  "--progress",
]);
const DOCKER_TOP_DENY = new Set([
  "run",
  "exec",
  "rm",
  "rmi",
  "stop",
  "restart",
  "kill",
  "build",
  "pull",
  "start",
  "create",
  "push",
  "load",
  "import",
  "pause",
  "unpause",
  "update",
  "rename",
  "cp",
  "prune",
]);
const COMPOSE_DENY = new Set([
  "up",
  "down",
  "restart",
  "stop",
  "rm",
  "build",
  "pull",
  "run",
  "exec",
  "start",
  "kill",
  "create",
  "push",
  "pause",
  "unpause",
  "scale",
  "cp",
]);
const DOCKER_GROUP_DENY: Record<string, ReadonlySet<string>> = {
  network: new Set(["create", "rm", "prune", "connect", "disconnect"]),
  volume: new Set(["create", "rm", "prune", "update"]),
  system: new Set(["prune"]),
  container: new Set([
    "run",
    "exec",
    "rm",
    "stop",
    "restart",
    "kill",
    "start",
    "create",
    "prune",
    "pause",
    "unpause",
    "update",
    "rename",
    "cp",
  ]),
  image: new Set(["rm", "build", "pull", "push", "prune", "load", "import"]),
  builder: new Set(["build", "prune"]),
  buildx: new Set(["build", "bake", "prune", "rm", "create"]),
  stack: new Set(["deploy", "rm"]),
  service: new Set(["create", "update", "rm", "scale", "rollback"]),
  swarm: new Set(["init", "join", "leave"]),
};

const MAX_DEPTH = 3;
const MAX_CODE = 64 * 1024;
const MAX_PUSH_DIRS = 8;
const MAX_FIND_COMBINATIONS = 200;
const TOO_LONG = "Befehlstext zu lang für die Sperrlisten-Prüfung; kürzer fassen";
const REDIRECT_WRITE = "\u0000W";
const REDIRECT_READ = "\u0000R";

interface Segment {
  readonly words: string[];
  /** Targets of `>`, `>>`, `&>`. */
  readonly writes: string[];
}

/** Splits a command line into simple commands made of words. Quotes are removed, operators split. */
function tokenize(line: string): Segment[] {
  const segments: Segment[] = [];
  let tokens: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const endWord = () => {
    if (inWord) tokens.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    const words: string[] = [];
    const writes: string[] = [];
    for (let k = 0; k < tokens.length; k += 1) {
      const token = tokens[k]!;
      if (token === REDIRECT_WRITE || token === REDIRECT_READ) {
        const target = tokens[k + 1];
        if (target !== undefined && token === REDIRECT_WRITE) writes.push(target);
        k += 1;
      } else words.push(token);
    }
    if (words.length > 0 || writes.length > 0) segments.push({ words, writes });
    tokens = [];
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) {
        i += 1;
        word += line[i]!;
      } else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      i += 1;
      if (line[i] !== "\n") {
        word += line[i]!;
        inWord = true;
      }
    } else if (ch === " " || ch === "\t") {
      endWord();
    } else if (ch === ">" || ch === "<" || (ch === "&" && line[i + 1] === ">")) {
      // A file descriptor number right before the operator belongs to it.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      let j = ch === "&" ? i + 1 : i;
      const op = line[j]!;
      j += 1;
      if (op === ">") {
        if (line[j] === ">" || line[j] === "|") j += 1;
      } else {
        while (line[j] === "<") j += 1;
      }
      let duplicate = false;
      if (op === ">" && line[j] === "&") {
        j += 1;
        if (/[0-9-]/.test(line[j] ?? "")) {
          duplicate = true;
          while (/[0-9-]/.test(line[j] ?? "")) j += 1;
        }
      }
      if (!duplicate) tokens.push(op === ">" ? REDIRECT_WRITE : REDIRECT_READ);
      i = j - 1;
    } else if (";&|\n()`".includes(ch)) {
      endSegment();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

/** Removes here-document bodies from the main text and returns them separately. */
function splitHeredocs(command: string): { main: string; bodies: string[] } {
  const lines = command.split("\n");
  const main: string[] = [];
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    main.push(line);
    const match = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (match === null) continue;
    const delimiter = match[2]!;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() !== delimiter) {
      body.push(lines[j]!);
      j += 1;
    }
    bodies.push(body.join("\n"));
    i = j;
  }
  return { main: main.join("\n"), bodies };
}

const baseName = (word: string) => word.slice(word.lastIndexOf("/") + 1);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Drops assignments, reserved words and the wrappers that only start another command. */
function stripPrefix(tokens: string[]): string[] {
  let i = 0;
  const skipOptions = (valued: ReadonlyArray<string>) => {
    while (i < tokens.length && tokens[i]!.startsWith("-")) {
      i += valued.includes(tokens[i]!) ? 2 : 1;
    }
  };
  while (i < tokens.length) {
    const first = tokens[i]!;
    const name = baseName(first);
    if (ASSIGNMENT.test(first) || RESERVED.has(first)) {
      i += 1;
    } else if (name === "env") {
      i += 1;
      while (i < tokens.length) {
        const w = tokens[i]!;
        if (w === "-u" || w === "-C" || w === "--chdir" || w === "--unset") i += 2;
        else if (w.startsWith("-") || ASSIGNMENT.test(w)) i += 1;
        else break;
      }
    } else if (name === "nice" || name === "ionice") {
      i += 1;
      skipOptions(["-n", "-c"]);
    } else if (name === "stdbuf") {
      i += 1;
      skipOptions([]);
    } else if (name === "timeout") {
      i += 1;
      skipOptions(["-k", "-s"]);
      i += 1;
    } else if (name === "command") {
      i += 1;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        if (tokens[i] === "-v" || tokens[i] === "-V") return [];
        i += 1;
      }
    } else if (name === "exec") {
      i += 1;
      skipOptions(["-a"]);
    } else break;
  }
  return tokens.slice(i);
}

const FORCE_PUSH_FLAG = /^-[A-Za-z]*f[A-Za-z]*$/;
const PUSH_MAIN_REASON =
  "git push auf main oder master ist Sache des Menschen; arbeite auf einem eigenen Branch und eröffne einen PR";

function protectedBranch(refspec: string): boolean {
  const dst = refspec
    .replace(/^\+/, "")
    .split(":")
    .pop()!
    .replace(/^refs\/heads\//, "");
  return dst === "main" || dst === "master";
}

function checkGitPush(args: string[], ctx: DenylistContext): string | null {
  let i = 0;
  const valueOpts = new Set([
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
  ]);
  let dir = ctx.cwd;
  let dirKnown = true;
  while (i < args.length && args[i]!.startsWith("-")) {
    const opt = args[i]!;
    if (opt === "-C" && args[i + 1] !== undefined) {
      const next = args[i + 1]!;
      dir = next.includes("$") || next.includes("`") ? null : resolveDir(next, dir, ctx.home);
    } else if (opt === "--git-dir" || opt === "--work-tree" || opt.startsWith("--git-dir=")) {
      dirKnown = false;
    }
    i += valueOpts.has(opt) ? 2 : 1;
  }
  if (args[i] !== "push") return null;
  const positional: string[] = [];
  let tags = false;
  for (let j = i + 1; j < args.length; j += 1) {
    const a = args[j]!;
    if (a === "--") {
      positional.push(...args.slice(j + 1));
      break;
    }
    if (
      a === "--force" ||
      a === "-f" ||
      a === "--mirror" ||
      a === "--force-if-includes" ||
      a.startsWith("--force-with-lease")
    ) {
      return "git push mit --force, -f oder --force-with-lease überschreibt fremde Stände";
    }
    if (!a.startsWith("--") && FORCE_PUSH_FLAG.test(a)) {
      return "git push mit --force, -f oder --force-with-lease überschreibt fremde Stände";
    }
    if (a === "--tags") tags = true;
    if (
      a === "--repo" ||
      a === "-o" ||
      a === "--push-option" ||
      a === "--receive-pack" ||
      a === "--exec"
    ) {
      j += 1;
      continue;
    }
    if (a.startsWith("-")) continue;
    positional.push(a);
  }
  for (const spec of positional.slice(1)) {
    if (spec.startsWith("+")) return "git push mit +Refspec erzwingt den Push";
  }
  for (const spec of positional) {
    if (protectedBranch(spec)) return PUSH_MAIN_REASON;
  }
  const needsBranch =
    (positional.length <= 1 && !tags) || positional.slice(1).some((s) => s === "HEAD" || s === "@");
  if (needsBranch && dirKnown && dir !== null) {
    ctx.pushDirs?.add(dir);
    const branch = ctx.branchOf?.(dir);
    if (branch === "main" || branch === "master") return PUSH_MAIN_REASON;
  }
  return null;
}

function checkSystemctl(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      if (SYSTEMCTL_VALUE_OPTS.has(a)) i += 1;
      continue;
    }
    return SYSTEMCTL_DENY.has(a) ? `systemctl ${a} ändert Dienste` : null;
  }
  return null;
}

const SERVICE_DENY = new Set([
  "start",
  "stop",
  "restart",
  "reload",
  "force-reload",
  "try-restart",
  "condrestart",
]);

function checkService(args: string[]): string | null {
  const positional = args.filter((a) => !a.startsWith("-"));
  const verb = positional[1];
  return verb !== undefined && SERVICE_DENY.has(verb) ? `service ${verb} ändert Dienste` : null;
}

function checkDocker(command: string, args: string[]): string | null {
  const reason = (verb: string) => `docker ${verb} ändert Container, Images, Netze oder Volumes`;
  let rest = args;
  let isCompose = command === "docker-compose";
  if (!isCompose) {
    let i = 0;
    while (i < rest.length && rest[i]!.startsWith("-"))
      i += DOCKER_VALUE_OPTS.has(rest[i]!) ? 2 : 1;
    rest = rest.slice(i);
    const sub = rest[0];
    if (sub === undefined) return null;
    if (sub === "compose") {
      isCompose = true;
      rest = rest.slice(1);
    } else {
      const group = DOCKER_GROUP_DENY[sub];
      if (group !== undefined) {
        const verb = rest.slice(1).find((a) => !a.startsWith("-"));
        return verb !== undefined && group.has(verb) ? reason(`${sub} ${verb}`) : null;
      }
      return DOCKER_TOP_DENY.has(sub) ? reason(sub) : null;
    }
  }
  let i = 0;
  while (i < rest.length && rest[i]!.startsWith("-")) i += COMPOSE_VALUE_OPTS.has(rest[i]!) ? 2 : 1;
  const verb = rest[i];
  return verb !== undefined && COMPOSE_DENY.has(verb) ? reason(`compose ${verb}`) : null;
}

function expandHome(raw: string, home: string): string {
  for (const [prefix, base] of [
    ["~", home],
    ["$HOME", home],
    ["${HOME}", home],
    ["$TMPDIR", "/tmp"],
    ["${TMPDIR}", "/tmp"],
  ] as const) {
    if (raw === prefix || raw.startsWith(`${prefix}/`)) return base + raw.slice(prefix.length);
  }
  return raw;
}

/** Path for a word. Null when it cannot be checked (variables), "" when relative and the directory is unknown. */
function resolveTarget(raw: string, ctx: DenylistContext, home: string): string | null {
  const value = expandHome(raw, home);
  if (value.includes("$") || value.includes("`")) return null;
  if (NodePath.posix.isAbsolute(value))
    return NodePath.posix.normalize(value).replace(/(.)\/+$/, "$1");
  if (ctx.cwd !== null) return NodePath.posix.resolve(ctx.cwd, value);
  return value.split("/").includes("..") ? null : "";
}

function resolveDir(raw: string, cwd: string | null, homeOption?: string): string | null {
  const home = NodePath.posix.normalize(homeOption ?? NodeOS.homedir());
  const resolved = resolveTarget(raw, { cwd }, home);
  return resolved && resolved.length <= 1024 ? resolved : null;
}

const RM_ROOTS = ["/tmp", "/var/tmp", "/root/.local/state/flightplan/worktrees"];

function checkRm(args: string[], ctx: DenylistContext, home: string): string | null {
  let recursive = false;
  const targets: string[] = [];
  let optionsDone = false;
  for (const a of args) {
    if (!optionsDone && a === "--") optionsDone = true;
    else if (!optionsDone && a.startsWith("--")) recursive ||= a === "--recursive";
    else if (!optionsDone && a.startsWith("-") && a.length > 1) recursive ||= /[rR]/.test(a);
    else targets.push(a);
  }
  if (!recursive) return writeReason(targets, ctx);
  const rootCwd = ctx.rootCwd === undefined ? ctx.cwd : ctx.rootCwd;
  const cwd = rootCwd !== null && rootCwd !== "/" ? NodePath.posix.normalize(rootCwd) : null;
  for (const raw of targets) {
    const path = resolveTarget(raw, ctx, home);
    if (path === null) return `rekursives rm auf einen nicht prüfbaren Pfad (${raw})`;
    if (path === "") {
      return `rekursives rm auf ${raw}, der wirksame Arbeitsordner ist unbekannt`;
    }
    if (path === "/" || path === home || /^\/\*+$/.test(path)) {
      return `rekursives rm auf ${raw} löscht den Host oder das Home-Verzeichnis`;
    }
    const below = (root: string) => path.startsWith(root.endsWith("/") ? root : `${root}/`);
    if (cwd !== null && below(cwd)) continue;
    const root = RM_ROOTS.find(below);
    if (root === undefined) {
      return `rekursives rm auf ${raw} außerhalb des Arbeitsordners (erlaubt: darunter, /tmp, /var/tmp, Flightplan-Worktrees)`;
    }
    if (/[*?[]/.test(path.slice(root.length + 1).split("/")[0]!)) {
      return `rekursives rm auf ${raw} mit Muster direkt unter ${root} würde fremde Arbeit löschen`;
    }
  }
  return null;
}

const NO_VALUE: ReadonlyArray<string> = [];

/** Non-option words; `valued` options take the next word, `-t` and `--target-directory` are reported. */
function splitArgs(
  args: string[],
  valued: ReadonlyArray<string> = NO_VALUE,
): { positional: string[]; targetDir: string | null; flags: string[] } {
  const positional: string[] = [];
  const flags: string[] = [];
  let targetDir: string | null = null;
  let done = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (done || !a.startsWith("-") || a === "-") {
      positional.push(a);
    } else if (a === "--") {
      done = true;
    } else if (a === "-t" || a === "--target-directory") {
      targetDir = args[i + 1] ?? null;
      i += 1;
    } else if (a.startsWith("--target-directory=")) {
      targetDir = a.slice("--target-directory=".length);
    } else {
      flags.push(a);
      if (valued.includes(a)) i += 1;
    }
  }
  return { positional, targetDir, flags };
}

function writeReason(paths: ReadonlyArray<string>, ctx: DenylistContext): string | null {
  for (const raw of paths) {
    const reason = checkWritePath(raw, ctx);
    if (reason !== null) return reason;
  }
  return null;
}

const IGNORED_REDIRECTS = /^\/dev\/(null|stderr|stdout|stdin|tty|fd\/\d+)$/;

function checkRedirects(targets: ReadonlyArray<string>, ctx: DenylistContext): string | null {
  return writeReason(
    targets.filter((t) => !IGNORED_REDIRECTS.test(t)),
    ctx,
  );
}

const COPY_LIKE = new Set(["cp", "mv", "install", "ln", "rsync"]);
const ALL_ARGS_WRITERS = new Set([
  "tee",
  "touch",
  "mkdir",
  "rmdir",
  "truncate",
  "unlink",
  "shred",
  "chmod",
  "chown",
  "chgrp",
]);
const VALUED_OPTS: Record<string, ReadonlyArray<string>> = {
  cp: ["-S", "--suffix"],
  mv: ["-S", "--suffix"],
  install: ["-m", "-o", "-g", "-S"],
  ln: ["-S", "--suffix"],
  rsync: ["-e", "--rsh", "--exclude", "--include", "--filter", "-f", "--exclude-from"],
  truncate: ["-s", "--size", "-r", "--reference"],
  touch: ["-d", "-r", "-t", "--date", "--reference"],
  mkdir: ["-m", "--mode"],
};

function checkCopyLike(command: string, args: string[], ctx: DenylistContext): string | null {
  const { positional, targetDir, flags } = splitArgs(args, VALUED_OPTS[command]);
  if (command === "install" && flags.some((f) => f === "-d" || f === "--directory")) {
    return writeReason(positional, ctx);
  }
  const remote = (p: string) => /^[^/]*:/.test(p);
  const sources = targetDir === null ? positional.slice(0, -1) : positional;
  const target = targetDir ?? positional[positional.length - 1];
  const paths: string[] = target === undefined || remote(target) ? [] : [target];
  if (command === "mv") paths.push(...sources.filter((p) => !remote(p)));
  return writeReason(paths, ctx);
}

function checkSed(args: string[], ctx: DenylistContext): string | null {
  const inPlace = args.some((a) => /^-[A-Za-z]*i[A-Za-z.]*$/.test(a) || a.startsWith("--in-place"));
  if (!inPlace) return null;
  return writeReason(splitArgs(args, ["-e", "-f", "--expression", "--file"]).positional, ctx);
}

function checkDd(args: string[], ctx: DenylistContext): string | null {
  return writeReason(
    args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)),
    ctx,
  );
}

function checkFind(args: string[], ctx: DenylistContext, depth: number, home: string) {
  let i = 0;
  while (i < args.length && /^-[HLP]$/.test(args[i]!)) i += 1;
  const paths: string[] = [];
  while (i < args.length && !args[i]!.startsWith("-") && args[i] !== "(" && args[i] !== "!") {
    paths.push(args[i]!);
    i += 1;
  }
  if (paths.length === 0) paths.push(".");
  const expr = args.slice(i);
  if (expr.includes("-delete")) {
    for (const p of paths) {
      const resolved = resolveTarget(p, ctx, home);
      if (resolved === "/" || resolved === home) return `find -delete auf ${p}`;
      const reason = checkWritePath(p, ctx);
      if (reason !== null) return `find -delete: ${reason}`;
    }
  }
  const commands: string[][] = [];
  for (let j = 0; j < expr.length; j += 1) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(expr[j]!)) continue;
    const inner: string[] = [];
    let k = j + 1;
    while (k < expr.length && !(expr[k] === ";" || (expr[k] === "+" && expr[k - 1] === "{}"))) {
      inner.push(expr[k]!);
      k += 1;
    }
    if (inner.length > 0) commands.push(inner);
    j = k;
  }
  if (paths.length * commands.length > MAX_FIND_COMBINATIONS) return TOO_LONG;
  for (const inner of commands) {
    for (const p of paths) {
      const base = p.endsWith("/") ? p : `${p}/`;
      const substituted = inner.map((w) =>
        w.includes("{}") ? w.replaceAll("{}", `${base}{}`) : w,
      );
      const verdict = checkWords(stripPrefix(substituted), ctx, depth + 1);
      if (verdict !== null) return verdict;
    }
  }
  return null;
}

const XARGS_VALUED = ["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "-i"];
const SSH_VALUED = [
  "-p",
  "-i",
  "-l",
  "-o",
  "-F",
  "-J",
  "-L",
  "-R",
  "-D",
  "-b",
  "-c",
  "-E",
  "-e",
  "-S",
  "-w",
];

const CODE_FLAGS: Record<string, RegExp> = {
  python: /^-[A-Za-z]*c$/,
  node: /^(-e|-p|-pe|-ep|--eval|--print)$/,
  perl: /^-[A-Za-z]*[eE]$/,
  ruby: /^-e$/,
  php: /^-r$/,
  lua: /^-e$/,
};

function interpreterFamily(command: string): string | null {
  if (/^python[0-9.]*$/.test(command)) return "python";
  if (command === "node" || command === "nodejs" || command === "bun") return "node";
  if (command === "perl" || command === "ruby" || command === "php" || command === "lua") {
    return command;
  }
  return null;
}

/** Code text of an interpreter call, or null when it runs a file or has none. */
function interpreterCode(family: string, command: string, args: string[]): string | null {
  if (command === "deno" && args[0] === "eval") return args[1] ?? null;
  const flag = CODE_FLAGS[family];
  if (flag === undefined) return null;
  const at = args.findIndex((a) => flag.test(a));
  if (at >= 0) return args[at + 1] ?? null;
  const long = args.find((a) => a.startsWith("--eval=") || a.startsWith("--print="));
  return long === undefined ? null : long.slice(long.indexOf("=") + 1);
}

const SCAN_COMMANDS = new Set([
  "sudo",
  "doas",
  "git",
  "systemctl",
  "service",
  "docker",
  "docker-compose",
  "fp-op",
  "rm",
]);

/** Looks for the core commands as words in code text. Linear, text is capped. */
function scanCode(text: string, ctx: DenylistContext): string | null {
  if (text.length > MAX_CODE) return TOO_LONG;
  for (const part of text.split(/[\n;|&]+/)) {
    const words = part.split(/[\s"'`(),[\]{}]+/).filter((w) => w.length > 0);
    for (let k = 0; k < words.length; k += 1) {
      if (!SCAN_COMMANDS.has(baseName(words[k]!))) continue;
      const verdict = checkWords(words.slice(k), ctx, MAX_DEPTH);
      if (verdict !== null) return verdict;
    }
  }
  return null;
}

function checkWords(words: string[], ctx: DenylistContext, depth: number): string | null {
  const first = words[0];
  if (first === undefined) return null;
  const command = baseName(first);
  const args = words.slice(1);
  const home = NodePath.posix.normalize(ctx.home ?? NodeOS.homedir());
  if (command === "sudo" || command === "doas") return "sudo ist nicht erlaubt";
  if (command === "git") return checkGitPush(args, ctx);
  if (command === "systemctl") return checkSystemctl(args);
  if (command === "service") return checkService(args);
  if (command === "docker" || command === "docker-compose") return checkDocker(command, args);
  if (command === "fp-op") {
    return args.find((a) => !a.startsWith("-")) === "doctor"
      ? "fp-op doctor ist nicht erlaubt"
      : null;
  }
  if (command === "rm") return checkRm(args, ctx, home);
  if (COPY_LIKE.has(command)) return checkCopyLike(command, args, ctx);
  if (ALL_ARGS_WRITERS.has(command)) {
    return writeReason(splitArgs(args, VALUED_OPTS[command]).positional, ctx);
  }
  if (command === "sed") return checkSed(args, ctx);
  if (command === "dd") return checkDd(args, ctx);
  if (command === "find") return checkFind(args, ctx, depth, home);
  if (depth >= MAX_DEPTH) return null;
  if (command === "xargs") {
    return checkWords(stripPrefix(splitArgsAfterOptions(args, XARGS_VALUED)), ctx, depth + 1);
  }
  if (command === "watch") {
    const inner = splitArgsAfterOptions(args, ["-n", "--interval", "-d"]).join(" ");
    return inner.length > MAX_CODE ? TOO_LONG : checkBash(inner, ctx, depth + 1);
  }
  if (command === "ssh") {
    const rest = splitArgsAfterOptions(args, SSH_VALUED).slice(1).join(" ");
    return rest.length > MAX_CODE
      ? TOO_LONG
      : checkBash(rest, { ...ctx, cwd: null, rootCwd: null }, depth + 1);
  }
  let code: string | null = null;
  let parse = false;
  if (command === "eval") {
    code = args.join(" ");
    parse = true;
  } else if (SHELLS.has(command)) {
    const at = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    code = at >= 0 ? (args[at + 1] ?? null) : null;
    parse = true;
  } else {
    const family = interpreterFamily(command) ?? (command === "deno" ? "deno" : null);
    if (family !== null) code = interpreterCode(family, command, args);
  }
  if (code === null) return null;
  if (code.length > MAX_CODE) return TOO_LONG;
  if (parse) {
    const verdict = checkBash(code, ctx, depth + 1);
    if (verdict !== null) return verdict;
  }
  return scanCode(code, ctx);
}

/** The words after leading options (options in `valued` take one value). */
function splitArgsAfterOptions(args: string[], valued: ReadonlyArray<string>): string[] {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += valued.includes(args[i]!) ? 2 : 1;
  return args.slice(i);
}

function cdTarget(words: string[], ctx: DenylistContext): string | null | undefined {
  const name = baseName(words[0] ?? "");
  if (name === "popd") return null;
  if (name !== "cd" && name !== "pushd") return undefined;
  const rest = words.slice(1).filter((w) => w !== "-P" && w !== "-L" && w !== "--");
  const target = rest[0];
  if (target === undefined || target === "-" || target.includes("$") || target.includes("`")) {
    return null;
  }
  return resolveDir(target, ctx.cwd, ctx.home);
}

/** Reason for a deny, or null. The effective directory follows literal `cd` in the chain. */
export function checkBash(command: string, start: DenylistContext, depth = 0): string | null {
  const ctx = start.rootCwd === undefined ? { ...start, rootCwd: start.cwd } : start;
  const { main, bodies } = splitHeredocs(command);
  const segments = tokenize(main);
  let cwd = ctx.cwd;
  for (const segment of segments) {
    const local = cwd === ctx.cwd ? ctx : { ...ctx, cwd };
    const redirect = checkRedirects(segment.writes, local);
    if (redirect !== null) return redirect;
    const words = stripPrefix(segment.words);
    const verdict = checkWords(words, local, depth);
    if (verdict !== null) return verdict;
    const moved = cdTarget(words, local);
    if (moved !== undefined) cwd = moved;
  }
  const feedsInterpreter = segments.some((segment) => {
    const name = baseName(stripPrefix(segment.words)[0] ?? "");
    return SHELLS.has(name) || name === "eval" || interpreterFamily(name) !== null;
  });
  if (feedsInterpreter) {
    for (const body of bodies) {
      if (body.length > MAX_CODE) return TOO_LONG;
      const verdict =
        (depth < MAX_DEPTH ? checkBash(body, ctx, depth + 1) : null) ?? scanCode(body, ctx);
      if (verdict !== null) return verdict;
    }
  }
  return null;
}

const PROTECTED_ROOTS = [
  "/etc",
  "/opt",
  "/usr",
  "/var/lib",
  "/root/.claude",
  "/root/.ssh",
  "/root/.config",
];
const PROTECTED_HOME_DIRS = [".claude", ".ssh", ".config", ".hermes"];
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function checkWritePath(rawPath: string, ctx: DenylistContext): string | null {
  const home = NodePath.posix.normalize(ctx.home ?? NodeOS.homedir());
  const resolved = resolveTarget(rawPath, ctx, home);
  const path = resolved === null || resolved === "" ? NodePath.posix.normalize(rawPath) : resolved;
  const protectedRoots = [
    ...PROTECTED_ROOTS,
    ...PROTECTED_HOME_DIRS.map((dir) => `${home}/${dir}`),
  ];
  const hit =
    protectedRoots.some((root) => under(path, root)) ||
    /^\/home\/[^/]+\/\.(ssh|config|hermes)(\/|$)/.test(path);
  if (hit) return `Schreiben nach ${path} ist nicht erlaubt`;
  const segments = path.split("/");
  const file = segments[segments.length - 1];
  if (
    (file === "settings.json" || file === "settings.local.json") &&
    segments.slice(0, -1).includes(".claude")
  ) {
    return `Schreiben in die Claude-Einstellungen ${path} ist nicht erlaubt`;
  }
  return null;
}

export function checkToolCall(
  toolName: string,
  toolInput: unknown,
  ctx: DenylistContext,
): string | null {
  const input =
    toolInput !== null && typeof toolInput === "object"
      ? (toolInput as Record<string, unknown>)
      : {};
  if (toolName === "Bash") {
    return typeof input.command === "string" ? checkBash(input.command, ctx) : null;
  }
  if (FILE_TOOLS.has(toolName)) {
    const path = input.file_path ?? input.notebook_path;
    return typeof path === "string" ? checkWritePath(path, ctx) : null;
  }
  return null;
}

function readBranch(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "git",
      ["-C", dir, "symbolic-ref", "--short", "-q", "HEAD"],
      { timeout: 2_000, windowsHide: true },
      (error, stdout) => resolve(error === null ? stdout.trim() || null : null),
    );
  });
}

/**
 * Checks a tool call. A bare push needs the branch: the first pass collects the directories, the branches are
 * read once, the second pass decides. Unknown branch means free.
 */
export async function checkToolCallWithBranches(
  toolName: string,
  toolInput: unknown,
  ctx: DenylistContext,
  lookup: (dir: string) => Promise<string | null> = readBranch,
): Promise<string | null> {
  const pushDirs = new Set<string>();
  const first = checkToolCall(toolName, toolInput, { ...ctx, pushDirs });
  if (first !== null || pushDirs.size === 0) return first;
  if (pushDirs.size > MAX_PUSH_DIRS) {
    return "zu viele git push in einem Befehl für die Sperrlisten-Prüfung; aufteilen";
  }
  const branches = new Map<string, string | null>();
  await Promise.all([...pushDirs].map(async (dir) => branches.set(dir, await lookup(dir))));
  return checkToolCall(toolName, toolInput, { ...ctx, branchOf: (dir) => branches.get(dir) });
}

/** The `PreToolUse` hook for the SDK `hooks` option. The hook input carries the session directory. */
export function makeDenylistPreToolUseHook(
  fallbackCwd: string | null,
  lookup?: (dir: string) => Promise<string | null>,
): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    let reason: string | null;
    try {
      reason = await checkToolCallWithBranches(
        input.tool_name,
        input.tool_input,
        { cwd: input.cwd || fallbackCwd },
        lookup,
      );
    } catch {
      // A check that fails must not let the call through.
      reason = "die Prüfung des Aufrufs ist fehlgeschlagen";
    }
    if (reason === null) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denyMessage(reason),
      },
    };
  };
}
