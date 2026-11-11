import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  type DenylistContext,
  checkBash,
  checkToolCall,
  denyMessage,
  denylistAppliesToThread,
  denylistEnabled,
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
    "rm -rf /tmp/x",
    "rm -r -f /var/log",
    "rm -rf --no-preserve-root /",
    "rm -rf ../other",
    "rm -rf /work/treeX/y",
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
    "rm -rf /work/tree",
    "rm file.txt",
    "rm -f /tmp/x",
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

  it("rm: without a known directory every recursive rm on an absolute path is blocked", () => {
    const noCwd: DenylistContext = { cwd: null, home: "/root" };
    expect(blocked("rm -rf /work/tree/build", noCwd)).toBe(true);
    expect(blocked("rm -rf build", noCwd)).toBe(false);
    expect(blocked("rm -rf ../../x", noCwd)).toBe(true);
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
