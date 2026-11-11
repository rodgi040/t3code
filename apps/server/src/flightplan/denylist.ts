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
 *    `stdbuf` are skipped, a directory in front of the command name is ignored.
 *  - Write, Edit, MultiEdit, NotebookEdit: the target path (no shell redirects, see limits).
 *
 * Limits, stated honestly. This list stops the straight path, not a deliberate way around it.
 *  - It does not see through `sh -c`, `bash -c`, `eval`, `su -c` beyond one plain re-parse of the quoted
 *    text, and not through `python -c`, `node -e`, `perl -e`, `xargs`, `ssh host ...`, `find -exec`. For
 *    such wrappers it only looks for the core patterns as plain text inside their arguments.
 *  - Not seen: variables or aliases that hide a command, `$(...)` inside double quotes, base64, a script file
 *    (`bash run.sh`, `python x.py`), `git push` without arguments from a checked-out `main`, `git -c alias...`,
 *    `gh`/`curl` calls that do the same remotely, `mv`/`cp`/`tee`/`sed -i`/`>` into the protected paths
 *    (the path rule covers the file tools only), symlinks that point into a protected path, and the
 *    `rm` rule only knows the directory of the session.
 *  - The list does not replace a sandbox or a host-level control. Against a misled agent only OP#1845 helps.
 */
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

/**
 * True when the switch is on and one of the thread ids (thread, its root) is the thread of a ticket in the
 * server mapping. Free chats have no entry and stay untouched.
 */
export function denylistAppliesToThread(
  ticketThreadsFile: string | undefined,
  threadIds: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (ticketThreadsFile === undefined || !denylistEnabled(env)) return false;
  const known = new Set(
    Object.values(readTicketThreadMap(ticketThreadsFile)).map((r) => r.threadId),
  );
  return threadIds.some((id) => known.has(id));
}

export interface DenylistContext {
  /** Working directory of the thread. Null when unknown. */
  readonly cwd: string | null;
  readonly home?: string;
}

const MAX_DEPTH = 3;

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
const INTERPRETERS = new Set([
  "python",
  "python2",
  "python3",
  "node",
  "nodejs",
  "deno",
  "bun",
  "perl",
  "ruby",
  "php",
  "lua",
  "xargs",
  "watch",
  "ssh",
  "find",
  "nsenter",
  "chroot",
  "busybox",
]);

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

/** Splits a command line into simple commands made of words. Quotes are removed, operators split. */
function tokenize(line: string): string[][] {
  const segments: string[][] = [];
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
    if (tokens.length > 0) segments.push(tokens);
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

/** Drops assignments, reserved words and the wrappers that only start another command. */
function stripPrefix(tokens: string[]): string[] {
  let rest = [...tokens];
  for (;;) {
    const first = rest[0];
    if (first === undefined) return rest;
    const name = baseName(first);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || RESERVED.has(first)) {
      rest = rest.slice(1);
    } else if (name === "env") {
      rest = rest.slice(1);
      while (rest[0] !== undefined) {
        const w = rest[0];
        if (w === "-u" || w === "-C" || w === "--chdir" || w === "--unset") rest = rest.slice(2);
        else if (w.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) rest = rest.slice(1);
        else break;
      }
    } else if (name === "nice" || name === "ionice") {
      rest = rest.slice(1);
      while (rest[0] !== undefined && rest[0].startsWith("-")) {
        rest = rest[0] === "-n" || rest[0] === "-c" ? rest.slice(2) : rest.slice(1);
      }
    } else if (name === "stdbuf") {
      rest = rest.slice(1);
      while (rest[0] !== undefined && rest[0].startsWith("-")) rest = rest.slice(1);
    } else if (name === "timeout") {
      rest = rest.slice(1);
      while (rest[0] !== undefined && rest[0].startsWith("-")) {
        rest = rest[0] === "-k" || rest[0] === "-s" ? rest.slice(2) : rest.slice(1);
      }
      rest = rest.slice(1); // duration
    } else if (name === "command") {
      rest = rest.slice(1);
      while (rest[0] !== undefined && rest[0].startsWith("-")) {
        if (rest[0] === "-v" || rest[0] === "-V") return [];
        rest = rest.slice(1);
      }
    } else if (name === "exec") {
      rest = rest.slice(1);
      while (rest[0] !== undefined && rest[0].startsWith("-")) {
        rest = rest[0] === "-a" ? rest.slice(2) : rest.slice(1);
      }
    } else return rest;
  }
}

const FORCE_PUSH_FLAG = /^-[A-Za-z]*f[A-Za-z]*$/;

function protectedBranch(refspec: string): boolean {
  const dst = refspec
    .replace(/^\+/, "")
    .split(":")
    .pop()!
    .replace(/^refs\/heads\//, "");
  return dst === "main" || dst === "master";
}

function checkGitPush(args: string[]): string | null {
  let i = 0;
  const valueOpts = new Set([
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--super-prefix",
  ]);
  while (i < args.length && args[i]!.startsWith("-")) {
    i += valueOpts.has(args[i]!) ? 2 : 1;
  }
  if (args[i] !== "push") return null;
  const positional: string[] = [];
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
    if (protectedBranch(spec)) return "git push auf main oder master ist Sache des Menschen";
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

function resolveTarget(
  raw: string,
  ctx: DenylistContext,
  home: string,
): { path: string | null; raw: string } {
  let value = raw;
  if (value === "~" || value.startsWith("~/")) value = home + value.slice(1);
  else if (value === "$HOME" || value.startsWith("$HOME/"))
    value = home + value.slice("$HOME".length);
  else if (value === "${HOME}" || value.startsWith("${HOME}/"))
    value = home + value.slice("${HOME}".length);
  if (value.includes("$") || value.includes("`")) return { path: null, raw };
  if (NodePath.posix.isAbsolute(value))
    return { path: NodePath.posix.normalize(value).replace(/(.)\/+$/, "$1"), raw };
  if (ctx.cwd !== null) return { path: NodePath.posix.resolve(ctx.cwd, value), raw };
  return { path: value.split("/").includes("..") ? null : "", raw };
}

function insideCwd(path: string, cwd: string): boolean {
  return path === cwd || path.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`);
}

function checkRm(args: string[], ctx: DenylistContext): string | null {
  const home = NodePath.posix.normalize(ctx.home ?? NodeOS.homedir());
  let recursive = false;
  const targets: string[] = [];
  let optionsDone = false;
  for (const a of args) {
    if (!optionsDone && a === "--") optionsDone = true;
    else if (!optionsDone && a.startsWith("--")) recursive ||= a === "--recursive";
    else if (!optionsDone && a.startsWith("-") && a.length > 1) recursive ||= /[rR]/.test(a);
    else targets.push(a);
  }
  if (!recursive) return null;
  const cwd =
    ctx.cwd !== null && NodePath.posix.isAbsolute(ctx.cwd) && ctx.cwd !== "/"
      ? NodePath.posix.normalize(ctx.cwd)
      : null;
  for (const raw of targets) {
    const target = resolveTarget(raw, { cwd }, home);
    if (target.path === null) return `rekursives rm auf einen nicht prüfbaren Pfad (${raw})`;
    if (target.path === "") continue; // relative path, directory unknown
    if (target.path === "/" || target.path === home || /^\/\*+$/.test(target.path)) {
      return `rekursives rm auf ${raw} löscht den Host oder das Home-Verzeichnis`;
    }
    const absolute = NodePath.posix.isAbsolute(raw) || raw.startsWith("~") || raw.startsWith("$");
    if (cwd === null) {
      if (absolute)
        return `rekursives rm auf den absoluten Pfad ${raw} (Arbeitsverzeichnis unbekannt)`;
    } else if (!insideCwd(target.path, cwd)) {
      return `rekursives rm auf ${raw} außerhalb des Arbeitsverzeichnisses`;
    }
  }
  return null;
}

const CORE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|[^\w./-])sudo(\s|$|["'])/, "sudo ist nicht erlaubt"],
  [
    /\bgit\b[^\n;|&]*\bpush\b[^\n;|&]*(\s--force\b|\s--force-with-lease|\s--mirror\b|\s-[A-Za-z]*f[A-Za-z]*(\s|$|["'])|\s\+\S|\s(\S*:)?(refs\/heads\/)?(main|master)(\s|$|["']))/,
    "git push mit Force, +Refspec oder auf main/master",
  ],
  [
    /\bsystemctl\b[^\n;|&]*\s(start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload|edit|kill)(\s|$|["'])/,
    "systemctl ändert Dienste",
  ],
  [
    /\bdocker(-compose)?\b[^\n;|&]*\s(run|exec|rm|rmi|stop|restart|kill|build|pull|up|down)(\s|$|["'])/,
    "docker ändert Container, Images, Netze oder Volumes",
  ],
  [
    /\bdocker\b[^\n;|&]*\s(network|volume|system)\s+(create|rm|prune|connect|disconnect)\b/,
    "docker ändert Netze, Volumes oder das System",
  ],
  [/\bfp-op\s+doctor\b/, "fp-op doctor ist nicht erlaubt"],
  [
    /\brm\s+(-\S+\s+)*(-\S*[rR]\S*|--recursive)\s+(-\S+\s+)*(\/|~|\$HOME|\$\{HOME\})/,
    "rekursives rm auf einen absoluten Pfad",
  ],
];

function checkCoreText(text: string): string | null {
  for (const [pattern, reason] of CORE_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

function checkSegment(tokens: string[], ctx: DenylistContext, depth: number): string | null {
  const words = stripPrefix(tokens);
  const first = words[0];
  if (first === undefined) return null;
  const command = baseName(first);
  const args = words.slice(1);
  switch (command) {
    case "sudo":
    case "doas":
      return "sudo ist nicht erlaubt";
    case "git":
      return checkGitPush(args);
    case "systemctl":
      return checkSystemctl(args);
    case "docker":
    case "docker-compose":
      return checkDocker(command, args);
    case "fp-op":
      return args.includes("doctor") ? "fp-op doctor ist nicht erlaubt" : null;
    case "rm":
      return checkRm(args, ctx);
    default:
      break;
  }
  const isShell = SHELLS.has(command);
  if (
    isShell ||
    command === "eval" ||
    INTERPRETERS.has(command) ||
    /^python[0-9.]*$/.test(command)
  ) {
    const text = args.join(" ");
    if (depth < MAX_DEPTH) {
      let inner: string | null = null;
      if (command === "eval") inner = text;
      else if (isShell) {
        const at = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
        if (at >= 0 && args[at + 1] !== undefined) inner = args[at + 1]!;
      } else if (command === "xargs") {
        let i = 0;
        const valueOpts = new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "-i"]);
        while (i < args.length && args[i]!.startsWith("-")) i += valueOpts.has(args[i]!) ? 2 : 1;
        inner = args.slice(i).join(" ");
      }
      if (inner !== null) {
        const verdict = checkBash(inner, ctx, depth + 1);
        if (verdict !== null) return verdict;
      }
    }
    return checkCoreText(text);
  }
  return null;
}

/** Reason for a deny, or null. */
export function checkBash(command: string, ctx: DenylistContext, depth = 0): string | null {
  const { main, bodies } = splitHeredocs(command);
  const segments = tokenize(main);
  for (const tokens of segments) {
    const verdict = checkSegment(tokens, ctx, depth);
    if (verdict !== null) return verdict;
  }
  const feedsInterpreter = segments.some((tokens) => {
    const name = baseName(stripPrefix(tokens)[0] ?? "");
    return (
      SHELLS.has(name) || INTERPRETERS.has(name) || /^python[0-9.]*$/.test(name) || name === "eval"
    );
  });
  if (feedsInterpreter) {
    for (const body of bodies) {
      const verdict =
        (depth < MAX_DEPTH ? checkBash(body, ctx, depth + 1) : null) ?? checkCoreText(body);
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
  const target = resolveTarget(rawPath, ctx, home);
  const path =
    target.path === null || target.path === "" ? NodePath.posix.normalize(rawPath) : target.path;
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

/** The `PreToolUse` hook for the SDK `hooks` option. The hook input carries the session directory. */
export function makeDenylistPreToolUseHook(fallbackCwd: string | null): HookCallback {
  return (input) => {
    if (input.hook_event_name !== "PreToolUse") return Promise.resolve({});
    let reason: string | null;
    try {
      reason = checkToolCall(input.tool_name, input.tool_input, { cwd: input.cwd || fallbackCwd });
    } catch {
      // A check that fails must not let the call through.
      reason = "die Prüfung des Aufrufs ist fehlgeschlagen";
    }
    if (reason === null) return Promise.resolve({});
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denyMessage(reason),
      },
    });
  };
}
