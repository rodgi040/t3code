// Run: node --test integrations/flightplan-a2a/
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import { contextIdFor, createAgent, describeResult, parseAgents } from "./a2a-acp-agent.mjs";

const AGENT = NodeURL.fileURLToPath(new URL("./a2a-acp-agent.mjs", import.meta.url));

function rpc(child) {
  const pending = new Map();
  const updates = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id !== undefined) pending.get(msg.id)?.(msg);
      else updates.push(msg);
    }
  });
  let n = 0;
  return {
    updates,
    call: (method, params) =>
      new Promise((resolve) => {
        const id = ++n;
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
  };
}

NodeTest.test("ACP round trip over stdio with the fake transport", async () => {
  const child = NodeChildProcess.spawn(process.execPath, [AGENT], {
    env: { ...process.env, FP_A2A_TRANSPORT: "fake", FP_A2A_AGENTS: "flightplan,sebil" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const { call, updates } = rpc(child);
  const init = await call("initialize", { protocolVersion: 1 });
  NodeAssert.equal(init.result.protocolVersion, 1);
  const created = await call("session/new", { cwd: "/tmp", mcpServers: [] });
  const { sessionId, models } = created.result;
  NodeAssert.deepEqual(
    models.availableModels.map((m) => m.name),
    ["Gandalf", "sebil"],
  );
  const done = await call("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "hallo" }],
  });
  NodeAssert.equal(done.result.stopReason, "end_turn");
  NodeAssert.match(
    updates[0].params.update.content.text,
    /^\[fake:flightplan:ctx-[A-Za-z0-9]+\] hallo$/,
  );
  NodeAssert.equal(
    (await call("session/set_model", { sessionId, modelId: "sebil" })).result !== undefined,
    true,
  );
  await call("session/prompt", { sessionId, prompt: [{ type: "text", text: "x" }] });
  NodeAssert.match(updates[1].params.update.content.text, /^\[fake:sebil:/);
  NodeAssert.equal(
    (await call("session/set_model", { sessionId, modelId: "nope" })).error.code,
    -32602,
  );
  NodeAssert.equal((await call("bogus", {})).error.code, -32601);
  child.kill();
});

NodeTest.test("cancel aborts the transport and reports cancelled", async () => {
  const out = [];
  const agent = createAgent({
    agents: parseAgents({}),
    write: (s) => out.push(JSON.parse(s)),
    transport: ({ signal }) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve({ ok: false, kind: "cancelled" })),
      ),
  });
  const reply = (id) =>
    new Promise((resolve) => {
      const poll = () => {
        const found = out.find((m) => m.id === id);
        return found ? resolve(found) : setImmediate(poll);
      };
      poll();
    });
  agent.handleLine(JSON.stringify({ id: 1, method: "session/new", params: {} }));
  const sessionId = (await reply(1)).result.sessionId;
  agent.handleLine(
    JSON.stringify({
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "x" }] },
    }),
  );
  agent.handleLine(JSON.stringify({ method: "session/cancel", params: { sessionId } }));
  NodeAssert.equal((await reply(2)).result.stopReason, "cancelled");
});

NodeTest.test("describeResult and context ids", () => {
  NodeAssert.match(
    describeResult({ ok: false, kind: "rate_limit", error: "peer rate limit" }),
    /Do not retry/,
  );
  NodeAssert.equal(describeResult({ ok: true, state: "completed", text: "ok" }), "ok");
  NodeAssert.match(
    describeResult({ ok: true, state: "input_required", text: "which?" }),
    /asks a question/,
  );
  NodeAssert.match(contextIdFor("0b1c2d3e-aaaa-bbbb-cccc-ddddeeeeffff"), /^ctx-[0-9a-f]{24}$/);
  NodeAssert.notEqual(contextIdFor("s1flightplan"), contextIdFor("s1sebil"));
});
