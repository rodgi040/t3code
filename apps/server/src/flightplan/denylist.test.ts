import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  type DenylistContext,
  checkBash,
  checkToolCall,
  checkToolCallWithBranches,
  denyMessage,
  denialLogFile,
  denylistAppliesToThread,
  denylistEnabled,
  resetDenylistWarnings,
  makeDenylistPreToolUseHook,
} from "./denylist.ts";

const CWD = "/work/tree";
const ctx: DenylistContext = { cwd: CWD, home: "/root" };
const blocked = (command: string, c = ctx) => checkBash(command, c) !== null;

describe("denylist: Bash", () => {
  it.each([
    "git push --force origin feature/x",
    "git push -f",
    "git push origin feature/x --force-with-lease",
    "git push --force-with-lease=x origin x",
    "git push -uf origin x",
    "git push origin +feature/x",
    "git push origin main",
    "git push origin master",
    "git push origin HEAD:main",
    "git push origin HEAD:refs/heads/master",
    "git -C /x push origin main",
    "sudo ls",
    "/usr/bin/sudo -n true",
    "systemctl restart nginx",
    "systemctl --user stop foo",
    "systemctl daemon-reload",
    "systemctl enable --now foo",
    "systemctl kill foo",
    "docker compose up -d",
    "docker compose -f a.yml -p x down",
    "docker-compose restart web",
    "docker run --rm alpine",
    "docker exec -it c sh",
    "docker rm c",
    "docker rmi img",
    "docker --context x stop c",
    "docker build .",
    "docker pull img",
    "docker network create n",
    "docker volume rm v",
    "docker system prune -f",
    "fp-op doctor",
    "FP_OP_USER=claude fp-op doctor --fix",
    "rm -rf /",
    "rm -rf ~",
    "rm -rf $HOME",
    "rm -r -f /var/log",
    "rm -rf --no-preserve-root /",
    "rm -rf ../other",
    "rm -rf /work/treeX/y",
    "rm -rf /work/tree",
  ])("blocks %s", (command) => {
    expect(blocked(command)).toBe(true);
  });

  it.each([
    "git status && git push origin main",
    "echo ok; sudo ls",
    "ls | sudo tee /x",
    "true || docker rm c",
    "ls\nsystemctl stop x",
    "(cd x && git push -f)",
    "echo $(sudo id)",
    "env FOO=1 sudo ls",
    "nice -n 5 sudo ls",
    "timeout 30 git push --force",
    "command git push -f",
    "exec docker rm c",
    "FOO=bar timeout -k 5 10 nice -n 3 systemctl restart x",
  ])("checks every part of a chain: %s", (command) => {
    expect(blocked(command)).toBe(true);
  });

  it.each([
    `bash -c "git push --force origin x"`,
    `sh -c 'sudo ls'`,
    `bash -lc "cd x && docker rm c"`,
    `eval "systemctl stop foo"`,
    `xargs git push -f`,
    `python3 -c "import os; os.system('sudo ls')"`,
    `node -e "require('child_process').execSync('git push origin main')"`,
    `ssh host 'docker compose down'`,
    `bash <<EOF\nsudo ls\nEOF`,
  ])("blocks a wrapper with a blocked pattern inside: %s", (command) => {
    expect(blocked(command)).toBe(true);
  });

  it.each([
    "git push -u origin feature/op-1-x",
    "git push origin HEAD:feature/op-1-x",
    "git push origin feature/main-menu",
    "git push --tags",
    "git commit -m 'fix: docker run and sudo and git push -f'",
    "git status",
    "git log --oneline -5",
    "pnpm test",
    "npx vp test run a.test.ts",
    "rm -rf node_modules",
    "rm -rf ./dist",
    "rm -rf /work/tree/build",
    "rm file.txt",
    "rm -f /tmp/x",
    "rm -rf /tmp/foo",
    "rm -rf $TMPDIR/foo",
    "rm -rf /root/.local/state/flightplan/worktrees/op-2-y/node_modules",
    "cd /tmp && rm -rf foo",
    "cd /root/.local/state/flightplan/worktrees/op-2-y && rm -rf dist",
    "systemctl status nginx",
    "systemctl is-active x",
    "systemctl list-units --type=service",
    "systemctl cat x",
    "systemctl show x",
    "journalctl -u x",
    "docker ps -a",
    "docker logs c",
    "docker images",
    "docker inspect c",
    "docker compose ps",
    "docker compose logs -f web",
    "docker network ls",
    "fp-op get 1868",
    "fp-op ask 1868 --text x",
    "cat /etc/hosts",
    "ls /opt",
    "echo sudo",
    "pwd # sudo",
    "bash -c 'pnpm test'",
    "python3 -c 'print(1)'",
    "cat <<EOF\nsudo docker rm c\nEOF",
  ])("lets normal work through: %s", (command) => {
    expect(blocked(command)).toBe(false);
  });

  it("rm: without a known directory a relative target is blocked, /tmp stays free", () => {
    const noCwd: DenylistContext = { cwd: null, home: "/root" };
    expect(blocked("rm -rf /work/tree/build", noCwd)).toBe(true);
    expect(blocked("rm -rf build", noCwd)).toBe(true);
    expect(blocked("rm -rf ../../x", noCwd)).toBe(true);
    expect(blocked("rm -rf /tmp/x", noCwd)).toBe(false);
  });
});

describe("denylist: file tools", () => {
  it.each([
    ["Write", { file_path: "/etc/hosts" }],
    ["Edit", { file_path: "/opt/stack/a.yml" }],
    ["Write", { file_path: "/usr/local/bin/x" }],
    ["Write", { file_path: "/var/lib/x/y" }],
    ["Write", { file_path: "/root/.claude/CLAUDE.md" }],
    ["Write", { file_path: "/root/.ssh/authorized_keys" }],
    ["Edit", { file_path: "/root/.config/x" }],
    ["Write", { file_path: "/home/rodgi/.ssh/id" }],
    ["Write", { file_path: "/home/rodgi/.config/a" }],
    ["Write", { file_path: "/home/rodgi/.hermes/a" }],
    ["MultiEdit", { file_path: "/work/tree/.claude/settings.json" }],
    ["Write", { file_path: "/work/tree/.claude/settings.local.json" }],
    ["NotebookEdit", { notebook_path: "/etc/n.ipynb" }],
    ["Write", { file_path: "~/.ssh/config" }],
    ["Write", { file_path: "/work/tree/../../etc/passwd" }],
    ["Write", { file_path: "../../../etc/passwd" }],
  ])("blocks %s %j", (tool, input) => {
    expect(checkToolCall(tool, input, ctx)).not.toBeNull();
  });

  it.each([
    ["Write", { file_path: "/work/tree/apps/x.ts" }],
    ["Edit", { file_path: "apps/x.ts" }],
    ["Write", { file_path: "/work/tree/.claude/skills/a/SKILL.md" }],
    ["Write", { file_path: "/work/tree/settings.json" }],
    ["Write", { file_path: "/root/.local/state/x" }],
    ["Read", { file_path: "/etc/hosts" }],
    ["Grep", { pattern: "x" }],
  ])("lets %s %j through", (tool, input) => {
    expect(checkToolCall(tool, input, ctx)).toBeNull();
  });
});

describe("denylist: switch, thread mapping, hook", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fp-denylist-"));
  const file = NodePath.join(dir, "flightplan-ticket-threads.json");
  const uuid = "11111111-1111-4111-8111-111111111111";
  NodeFS.writeFileSync(
    file,
    JSON.stringify({ "1868": { threadId: uuid, environmentId: "e", projectId: "p" } }),
  );

  it("applies only to ticket threads", () => {
    expect(denylistAppliesToThread(file, [uuid], {})).toBe(true);
    expect(denylistAppliesToThread(file, ["other", uuid], {})).toBe(true);
    expect(denylistAppliesToThread(file, ["free-chat"], {})).toBe(false);
    expect(denylistAppliesToThread(undefined, [uuid], {})).toBe(false);
    expect(denylistAppliesToThread(NodePath.join(dir, "missing.json"), [uuid], {})).toBe(false);
  });

  it("is off with T3CODE_FP_DENYLIST=0", () => {
    expect(denylistEnabled({})).toBe(true);
    expect(denylistEnabled({ T3CODE_FP_DENYLIST: "1" })).toBe(true);
    expect(denylistEnabled({ T3CODE_FP_DENYLIST: "0" })).toBe(false);
    expect(denylistAppliesToThread(file, [uuid], { T3CODE_FP_DENYLIST: "0" })).toBe(false);
  });

  it("the hook denies with the fixed German message and passes normal calls", async () => {
    const hook = makeDenylistPreToolUseHook(CWD);
    const run = (tool_name: string, tool_input: unknown) =>
      hook(
        {
          hook_event_name: "PreToolUse",
          tool_name,
          tool_input,
          tool_use_id: "t",
          cwd: CWD,
        } as never,
        "t",
        { signal: new AbortController().signal },
      );
    const denied = await run("Bash", { command: "git push --force" });
    expect(denied).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denyMessage(
          "git push mit --force, -f oder --force-with-lease überschreibt fremde Stände",
        ),
      },
    });
    expect(denyMessage("x")).toBe(
      "Gesperrt für Ticket-Threads (Flightplan-Sperrliste): x. Führe das nicht auf anderem Weg aus. Stelle stattdessen eine Rückfrage mit fp-op ask.",
    );
    expect(await run("Bash", { command: "pnpm test" })).toEqual({});
    expect(await run("Write", { file_path: "/etc/x" })).not.toEqual({});
  });
});

describe("denylist: text search only on code text (A1)", () => {
  it.each([
    `find . -name "docker-compose*.yml" -exec grep -n "build" {} +`,
    `find . -name "*.md" | xargs grep -n "docker run"`,
    "bun run docker build",
    `python3 -m pytest -k "docker and run"`,
    "node scripts/docker-run.js",
    "xargs grep -n sudo",
    "find . -name '*.ts' -exec rm {} ;",
  ])("lets %s through", (command) => {
    expect(blocked(command)).toBe(false);
  });

  it.each([
    "xargs rm -rf /opt/x",
    "find /opt -exec rm -rf {} +",
    "find /opt -name x -execdir rm -rf {} \\;",
    "find /etc -name '*.bak' -delete",
    "find / -delete",
    "find . -exec sudo ls {} +",
    "ls | xargs -n 1 docker rm",
    `node -e "require('child_process').execSync('docker compose down')"`,
    `bun -p "Bun.spawnSync(['sudo','ls'])"`,
    `python -c "import os; os.system('systemctl stop x')"`,
  ])("blocks %s", (command) => {
    expect(blocked(command)).toBe(true);
  });
});

describe("denylist: rm roots and cd (A2)", () => {
  it.each([
    "rm -rf /tmp",
    "rm -rf /tmp/",
    "rm -rf /tmp/../etc",
    "rm -rf /var/tmp",
    "rm -rf /root/.local/state/flightplan/worktrees",
    "rm -rf /root/.local/state/flightplan/worktrees/../x",
    "rm -rf $OTHER/x",
    "cd / && rm -rf x",
    "cd /etc && rm -rf x",
    "cd && rm -rf x",
    "cd - && rm -rf x",
    "cd $SOMEWHERE && rm -rf x",
    "cd /tmp; cd .. ; rm -rf x",
  ])("blocks %s", (command) => {
    expect(blocked(command)).toBe(true);
  });

  it("follows a literal cd for the parts after it", () => {
    expect(blocked("cd sub && rm -rf build")).toBe(false);
    expect(blocked("cd /tmp/a && rm -rf ../b")).toBe(false);
    expect(blocked("cd /tmp/a && rm -rf ../../etc")).toBe(true);
    expect(blocked("cd /tmp/a && bash -c 'rm -rf ../../etc'")).toBe(true);
  });
});

describe("denylist: regex cost (A3)", () => {
  // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- guard against quadratic regex cost; the margin is large
  const now = () => Date.now();
  const timed = (command: string) => {
    const start = now();
    const verdict = checkBash(command, ctx);
    return { verdict, ms: now() - start };
  };

  const shapes: ReadonlyArray<readonly [string, (bytes: number) => string]> = [
    ["node -e wrapper", (n) => `node -e "${"git push origin x ".repeat(n / 16)}"`],
    ["plain words", (n) => "a ".repeat(n / 2)],
    ["git words", (n) => "git ".repeat(n / 4)],
    ["prefix words", (n) => "A=b ".repeat(n / 4) + "ls"],
    ["semicolons", (n) => "cd a;".repeat(n / 5)],
    ["shell -c", (n) => `bash -c '${"x ".repeat(n / 2)}'`],
    ["rm targets", (n) => "rm -rf " + "a ".repeat(n / 2)],
    ["find paths", (n) => "find " + "a ".repeat(n / 2) + "-exec rm {} +"],
    ["heredoc", (n) => `bash <<EOF\n${"git push origin x\n".repeat(n / 18)}EOF`],
  ];

  it.each(shapes)("a 60 KB input is checked fast: %s", (_name, build) => {
    const command = build(60_000);
    expect(command.length).toBeGreaterThan(55_000);
    expect(timed(command).ms).toBeLessThan(200);
  });

  it.each(shapes)("a 200 KB input returns fast (refused or checked): %s", (_name, build) => {
    const command = build(200_000);
    expect(command.length).toBeGreaterThan(190_000);
    expect(timed(command).ms).toBeLessThan(200);
  });

  it("refuses an over-long code text with a plain message", () => {
    expect(checkBash(`node -e "${"x ".repeat(40_000)}"`, ctx)).toBe(
      "Befehlstext zu lang für die Sperrlisten-Prüfung; kürzer fassen",
    );
    expect(checkBash(`bash -c '${"x ".repeat(40_000)}'`, ctx)).toContain("zu lang");
    expect(checkBash(`python3 - <<EOF\n${"print(1)\n".repeat(1200)}EOF`, ctx)).toBeNull();
  });
});

describe("denylist: push on main/master (B1)", () => {
  const onBranch = (branch: string | null): DenylistContext => ({
    ...ctx,
    branchOf: () => branch,
  });

  it.each([
    "git push",
    "git push origin",
    "git push origin HEAD",
    "git push -u origin HEAD",
    "git push origin @",
    "git -C /work/tree push",
  ])("blocks %s on a checked-out main", (command) => {
    expect(checkBash(command, onBranch("main"))).toContain("eigenen Branch");
    expect(checkBash(command, onBranch("master"))).toContain("PR");
    expect(checkBash(command, onBranch("feature/x"))).toBeNull();
    expect(checkBash(command, onBranch(null))).toBeNull();
    expect(checkBash(command, ctx)).toBeNull();
  });

  it("an explicit ref or --tags does not need the branch", () => {
    expect(checkBash("git push origin feature/x", onBranch("main"))).toBeNull();
    expect(checkBash("git push origin HEAD:feature/x", onBranch("main"))).toBeNull();
    expect(checkBash("git push --tags", onBranch("main"))).toBeNull();
    expect(checkBash("git push origin main", onBranch("feature/x"))).toContain("eigenen Branch");
  });

  it("the hook reads the branch of the effective directory once", async () => {
    const asked: string[] = [];
    const lookup = (dir: string) => {
      asked.push(dir);
      return Promise.resolve(dir === "/work/main-dir" ? "main" : "feature/x");
    };
    const run = (command: string) => checkToolCallWithBranches("Bash", { command }, ctx, lookup);
    expect(await run("cd /work/main-dir && git push")).toContain("eigenen Branch");
    expect(await run("git push")).toBeNull();
    expect(await run("git -C /work/main-dir push origin HEAD")).toContain("eigenen Branch");
    expect(await run("git status")).toBeNull();
    expect(asked).toEqual(["/work/main-dir", "/work/tree", "/work/main-dir"]);
  });

  it("a failing lookup means unknown, not blocked", async () => {
    const lookup = () => Promise.resolve(null);
    expect(
      await checkToolCallWithBranches("Bash", { command: "git push" }, ctx, lookup),
    ).toBeNull();
  });
});

describe("denylist: shell writes into protected paths (B2)", () => {
  it.each([
    "echo x > /etc/foo",
    "cat a > /opt/x",
    "echo x >> ~/.ssh/authorized_keys",
    ">/etc/x",
    "echo x >/etc/x",
    "echo x &>/etc/x",
    "echo x 2>/etc/x",
    "tee /etc/foo",
    "printf x | tee -a /etc/hosts",
    "cp a /opt/x",
    "cp -t /opt a b",
    "mv a /opt/b",
    "mv /opt/b ./b",
    "sed -i s/a/b/ /etc/x",
    "sed -i.bak -e s/a/b/ /etc/x",
    "install -m 644 a /etc/x",
    "install -d /opt/x",
    "ln -s a /opt/x",
    "chmod 777 /etc/x",
    "chown root /etc/x",
    "rsync -a x /opt/",
    "dd if=a of=/etc/x",
    "truncate -s 0 /etc/x",
    "touch /etc/x",
    "mkdir -p /opt/x",
    "rm /etc/x",
    "cd /etc && touch x",
    "cd /etc; echo x > y",
    "bash -c 'echo x > /etc/y'",
  ])("blocks %s", (command) => {
    expect(blocked(command)).toBe(true);
  });

  it.each([
    "cat /etc/hosts",
    "cp /etc/hosts ./kopie",
    "cp /etc/hosts /tmp/kopie",
    "mv a b",
    "echo x > out.txt",
    "echo x > /dev/null",
    "echo x 2>/dev/null",
    "ls 2>&1",
    "ls >&2",
    "ls &> /dev/null",
    "echo x > /tmp/y",
    "cat < /etc/hosts",
    "sed -n p /etc/hosts",
    "sed -i s/a/b/ file.txt",
    "install -m 644 a ./b",
    "rsync -a /opt/x ./x",
    "rsync -a x host:/opt/x",
    "tee out.log",
    "touch ./a",
    "mkdir -p dist/x",
    "dd if=/etc/hosts of=./x",
    "ln -s /etc/hosts ./hosts",
  ])("lets %s through", (command) => {
    expect(blocked(command)).toBe(false);
  });
});

describe("denylist: service, fp-op words, mapping file (B3)", () => {
  it.each(["service nginx restart", "service x start", "service x stop", "service x reload"])(
    "blocks %s",
    (command) => expect(blocked(command)).toBe(true),
  );
  it.each(["service x status", "service --status-all"])("lets %s through", (command) =>
    expect(blocked(command)).toBe(false),
  );

  it.each([
    "fp-op doctor",
    "FP_OP_USER=claude fp-op doctor",
    "fp-op --json doctor",
    "env X=1 fp-op doctor",
  ])("blocks %s", (command) => expect(blocked(command)).toBe(true));
  it.each([
    "fp-op comment 1 doctor",
    'fp-op ask 1868 --question "soll ich doctor starten?"',
    "fp-op get 1868",
  ])("lets %s through", (command) => expect(blocked(command)).toBe(false));

  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fp-denylist-map-"));
  const write = (name: string, content: string) => {
    const file = NodePath.join(dir, name);
    NodeFS.writeFileSync(file, content);
    return file;
  };
  const thread = "11111111-1111-4111-8111-111111111111";
  const good = write(
    "good.json",
    JSON.stringify({ "1": { threadId: thread, environmentId: "e", projectId: "p" } }),
  );

  it("applies for a direct thread id and for the root thread id, not without an entry", () => {
    expect(denylistAppliesToThread(good, [thread, "root-x"], {})).toBe(true);
    expect(denylistAppliesToThread(good, ["child-x", thread], {})).toBe(true);
    expect(denylistAppliesToThread(good, ["child-x", "root-x"], {})).toBe(false);
  });

  it("is off with the switch at 0", () => {
    expect(denylistAppliesToThread(good, [thread], { T3CODE_FP_DENYLIST: "0" })).toBe(false);
  });

  it("a broken mapping file turns the list off and warns once; a missing file is silent", () => {
    resetDenylistWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const broken = write("broken.json", "{ not json");
      expect(denylistAppliesToThread(broken, [thread], {})).toBe(false);
      expect(denylistAppliesToThread(broken, [thread], {})).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("off for all threads");
      expect(denylistAppliesToThread(NodePath.join(dir, "nope.json"), [thread], {})).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      resetDenylistWarnings();
    }
  });
});

describe("denylist: limits found in review round 3", () => {
  it("allows at most 8 push directories per command", async () => {
    const asked: string[] = [];
    const lookup = (dir: string) => {
      asked.push(dir);
      return Promise.resolve("feature/x");
    };
    const many = Array.from({ length: 5000 }, (_, i) => `git -C /tmp/d${i} push`).join("; ");
    expect(await checkToolCallWithBranches("Bash", { command: many }, ctx, lookup)).toBe(
      "zu viele git push in einem Befehl für die Sperrlisten-Prüfung; aufteilen",
    );
    expect(asked.length).toBeLessThanOrEqual(8);
    const eight = Array.from({ length: 8 }, (_, i) => `git -C /tmp/d${i} push`).join("; ");
    expect(await checkToolCallWithBranches("Bash", { command: eight }, ctx, lookup)).toBeNull();
    expect(asked.length).toBe(8);
  });

  it.each([
    "rm -rf /tmp/*",
    "rm -rf /tmp/op*",
    "rm -rf /tmp/o?",
    "rm -rf /tmp/[a-z]*",
    "rm -rf /var/tmp/*",
    "rm -rf /root/.local/state/flightplan/worktrees/*",
    "rm -rf /root/.local/state/flightplan/worktrees/*/node_modules",
    "rm -rf /work/tree/../*",
    "rm -rf $TMPDIR/*",
  ])("blocks a pattern directly under an allowed root: %s", (command) => {
    expect(blocked(command)).toBe(true);
  });

  it.each([
    "rm -rf /tmp/probe/*",
    "rm -rf /root/.local/state/flightplan/worktrees/op-1-x/dist/*",
    "rm -rf /root/.local/state/flightplan/worktrees/op-2-y",
    "rm -rf ./*",
    "rm -rf dist/*",
    "rm -rf /work/tree/*",
  ])("lets %s through", (command) => {
    expect(blocked(command)).toBe(false);
  });

  it("keeps cd with a variable and ssh as before", () => {
    expect(blocked('cd "$DIR" && rm -rf dist')).toBe(true);
    expect(blocked("ssh host 'sudo ls'")).toBe(true);
  });
});

describe("denylist: simple variables in one command", () => {
  it.each([
    'HELP=$(mktemp -d /tmp/op-1857-hilf.XXXX) && echo hi > "$HELP/a.txt" && rm -rf "$HELP"',
    'D=$(mktemp -d); rm -rf "$D"',
    'D=$(mktemp -d -t x.XXXX); rm -rf "$D"',
    'D=$(mktemp -d -p /tmp); rm -rf "$D"',
    'D=$(mktemp -d --tmpdir=/var/tmp); rm -rf "$D"',
    'D=$(mktemp -d --tmpdir x.XXXX); rm -rf "${D}"',
    'D=`mktemp -d`; rm -rf "$D/sub"',
    'D="$(mktemp -d)"; rm -rf $D',
    "export D=$(mktemp -d); rm -rf $D",
    'local D=$(mktemp -d /tmp/x.XXXX); rm -rf "$D"',
    "F=$(mktemp); echo x > $F; rm -rf $F",
    "T=/tmp/probe; rm -rf $T",
    'T="/tmp/probe"; rm -rf "$T/sub"',
    "T='/tmp/probe'; rm -rf ${T}/sub",
    "A=/tmp; B=$A/x; rm -rf $B",
    "P=$(pwd); rm -rf $P/dist",
    "rm -rf $PWD/dist",
    "H=~; rm -rf $H/../../tmp/x",
    'D=$(mktemp -d); cd "$D" && rm -rf x',
    'X=/etc; X=/tmp/y; rm -rf "$X"',
    "rm -rf $TMPDIR/probe",
  ])("lets %s through", (command) => {
    expect(blocked(command)).toBe(false);
  });

  it.each([
    'X=/etc; rm -rf "$X/foo"',
    'X=/; rm -rf "$X"',
    'D=$(mktemp -d); rm -rf "$D/../.."',
    'D=$(mktemp -d); rm -rf "$D/.."',
    'T=/tmp; rm -rf "$T"/*',
    'F=/opt/x; echo a > "$F"',
    'F=/opt/x; tee "$F"',
    'F=/opt/x; cp a "$F"',
    'X=/tmp/y; X=/etc; rm -rf "$X/foo"',
    "X=$(git rev-parse --show-toplevel); rm -rf $X",
    'DIR=$(git rev-parse --show-toplevel); cd "$DIR" && rm -rf dist',
    "rm -rf $NEVER_SET",
    "rm -rf $X; X=/tmp/y",
    "X=/tmp/y; unset X; rm -rf $X",
    "A=$A/x; rm -rf $A",
    'D=$(mktemp -d --suffix=x ../../etc/y.XXXX); rm -rf "$D"',
    "S=sudo; $S ls",
    "X=$(sudo id)",
    'X=$(mktemp -d -p "$OTHER"); rm -rf $X',
    "(X=/etc; true); rm -rf $X/y",
  ])("blocks %s", (command) => {
    expect(blocked(command)).toBe(true);
  });

  it("stays linear with many assignments", () => {
    // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- guard against quadratic cost; the margin is large
    const start = Date.now();
    const shapes = [
      "A=$(mktemp -d);".repeat(3500),
      "A=$A$A;".repeat(8000),
      "A=$(".repeat(12_000),
      "export A=/tmp/x;".repeat(3000) + "rm -rf $A",
    ];
    for (const command of shapes) {
      expect(command.length).toBeGreaterThan(24_000);
      checkBash(command, ctx);
    }
    // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- see above
    expect(Date.now() - start).toBeLessThan(800);
  });
});

// Flightplan OP#1890
describe("denylist: denial log", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fp-denials-"));
  const mapping = NodePath.join(dir, "flightplan-ticket-threads.json");
  const uuid = "22222222-2222-4222-8222-222222222222";
  NodeFS.writeFileSync(
    mapping,
    JSON.stringify({ "1890": { threadId: uuid, environmentId: "e", projectId: "p" } }),
  );
  const logFile = denialLogFile(mapping);
  const hookFor = (target?: { ticketThreadsFile: string; threadIds: string[] }) => {
    const hook = makeDenylistPreToolUseHook(CWD, undefined, target);
    return (tool_name: string, tool_input: unknown) =>
      hook(
        {
          hook_event_name: "PreToolUse",
          tool_name,
          tool_input,
          tool_use_id: "t",
          cwd: CWD,
        } as never,
        "t",
        { signal: new AbortController().signal },
      );
  };
  const lines = () =>
    NodeFS.existsSync(logFile)
      ? NodeFS.readFileSync(logFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];

  it("writes category, thread, ticket and protection flag, but never the command", async () => {
    const run = hookFor({ ticketThreadsFile: mapping, threadIds: [uuid, "root"] });
    await run("Bash", { command: "docker rm geheimer-container-name" });
    await run("Bash", { command: "git push origin main" });
    await run("Bash", { command: "git push --force origin feature/x" });
    await run("Bash", { command: "sudo cat /root/streng-geheim" });
    await run("Bash", { command: "systemctl stop nginx" });
    await run("Bash", { command: "rm -rf /home/other/dir-x" });
    await run("Bash", { command: "fp-op doctor" });
    await run("Write", { file_path: "/root/.ssh/id_x" });
    await run("Write", { file_path: "/etc/hosts" });
    expect(await run("Bash", { command: "pnpm test" })).toEqual({});
    const rows = lines();
    expect(rows.map((r) => [r.category, r.protected])).toEqual([
      ["docker", true],
      ["git-push-main", true],
      ["git-push-force", false],
      ["sudo", false],
      ["systemctl", false],
      ["rm-ausserhalb", false],
      ["fp-op-doctor", false],
      ["schreibziel-geschuetzt", true],
      ["schreibziel-geschuetzt", false],
    ]);
    for (const row of rows) {
      expect(row.threadId).toBe(uuid);
      expect(row.ticket).toBe("1890");
      expect(typeof row.at).toBe("string");
      expect(new Date(row.at as string).toISOString()).toBe(row.at);
      expect(Object.keys(row).toSorted()).toEqual(
        ["at", "category", "protected", "threadId", "ticket", "tool"].toSorted(),
      );
    }
    const raw = NodeFS.readFileSync(logFile, "utf8");
    for (const secret of ["geheimer-container-name", "streng-geheim", "dir-x", "id_x", "nginx"]) {
      expect(raw).not.toContain(secret);
    }
    expect(NodeFS.statSync(logFile).mode & 0o777).toBe(0o600);
  });

  it("a write error does not change the verdict", async () => {
    const blockedDir = NodePath.join(dir, "gibt-es-als-datei");
    NodeFS.writeFileSync(blockedDir, "x");
    const run = hookFor({
      ticketThreadsFile: NodePath.join(blockedDir, "flightplan-ticket-threads.json"),
      threadIds: [uuid],
    });
    expect(await run("Bash", { command: "sudo ls" })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("logs nothing without a target and for allowed calls", async () => {
    const before = lines().length;
    await hookFor()("Bash", { command: "sudo ls" });
    await hookFor({ ticketThreadsFile: mapping, threadIds: [uuid] })("Bash", { command: "ls" });
    expect(lines()).toHaveLength(before);
  });
});
