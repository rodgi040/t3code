#!/usr/bin/env node
// ACP agent (stdio, v1) that answers every prompt through A2A; T3 runs it as a local ACP command.
// Transport seam: "python" runs a2a_send.py (host A2A client), "fake" answers locally for tests.
// Environment and usage: README.md next to this file.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

const HERE = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const SEND_TIMEOUT_MS = 320_000; // A2A client waits up to 310 s

export function parseAgents(env = process.env) {
  const ids = (env.FP_A2A_AGENTS ?? "flightplan")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9][a-z0-9_-]*$/.test(s));
  let labels = { flightplan: "Gandalf" };
  try {
    if (env.FP_A2A_LABELS) labels = { ...labels, ...JSON.parse(env.FP_A2A_LABELS) };
  } catch {
    /* keep defaults */
  }
  return (ids.length ? ids : ["flightplan"]).map((id) => ({
    modelId: id,
    name: typeof labels[id] === "string" ? labels[id] : id,
  }));
}

/** A2A context ids must match [A-Za-z0-9_-]{1,64}; derive one from the ACP session id so a resumed session continues. */
export function contextIdFor(sessionId) {
  return `ctx-${NodeCrypto.createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 24)}`;
}

/** Transport: ({agent, message, contextId, signal}) => Promise<{ok, text?, state?, hint?, kind?, error?}> */
export function makePythonTransport(env = process.env) {
  const python = env.FP_A2A_PYTHON || "/usr/bin/python3";
  const script = env.FP_A2A_SEND || `${HERE}a2a_send.py`;
  return ({ agent, message, contextId, signal }) =>
    new Promise((resolve) => {
      const child = NodeChildProcess.spawn(python, ["-I", script], {
        stdio: ["pipe", "pipe", "ignore"],
        signal,
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), SEND_TIMEOUT_MS);
      child.on("error", () => {
        clearTimeout(timer);
        resolve({
          ok: false,
          kind: signal?.aborted ? "cancelled" : "spawn",
          error: "could not run the A2A helper",
        });
      });
      child.on("close", () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(stdout.trim().split("\n").pop() ?? ""));
        } catch {
          resolve({ ok: false, kind: "internal", error: "A2A helper returned no result" });
        }
      });
      child.stdin.end(JSON.stringify({ op: "send", agent, message, context_id: contextId }));
    });
}

export function makeFakeTransport() {
  return async ({ agent, message, contextId }) => ({
    ok: true,
    state: "completed",
    text: `[fake:${agent}:${contextId}] ${message}`,
    hint: "",
    context_id: contextId,
  });
}

export function makeTransport(env = process.env) {
  return env.FP_A2A_TRANSPORT === "fake" ? makeFakeTransport() : makePythonTransport(env);
}

function promptText(prompt) {
  return (Array.isArray(prompt) ? prompt : [])
    .map((block) => {
      if (block?.type === "text") return String(block.text ?? "");
      if (block?.type === "resource" && typeof block.resource?.text === "string")
        return block.resource.text;
      if (block?.type === "resource_link") return String(block.uri ?? "");
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/** Text shown for a result that is not a plain answer. */
export function describeResult(res) {
  if (!res.ok) {
    const hint =
      res.kind === "auth" ||
      res.kind === "untrusted" ||
      res.kind === "rate_limit" ||
      res.kind === "brake"
        ? " Do not retry; tell the maintainer."
        : "";
    return `A2A error (${res.kind ?? "unknown"}): ${res.error ?? "no details"}.${hint}`;
  }
  const text = (res.text ?? "").trim();
  if (res.state === "rejected" || res.state === "failed")
    return `A2A ${res.state}: ${res.hint || text || "no details"}`;
  if (res.state === "input_required")
    return `${text}\n\n(The agent asks a question; answer in your next message.)`;
  return text || (res.hint ? `(${res.hint})` : "(empty reply)");
}

export function createAgent({ transport, agents, write }) {
  const sessions = new Map();
  const send = (message) => write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

  const newSession = (sessionId) => {
    sessions.set(sessionId, { agent: agents[0].modelId, cancel: undefined });
    return {
      models: { currentModelId: agents[0].modelId, availableModels: agents },
    };
  };

  async function handleRequest(message) {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
          },
          authMethods: [],
          agentInfo: { name: "flightplan-a2a", version: "1" },
        };
      case "session/new": {
        const sessionId = NodeCrypto.randomUUID();
        return { sessionId, ...newSession(sessionId) };
      }
      case "session/load":
        return newSession(String(params.sessionId));
      case "session/set_model": {
        const session = sessions.get(String(params.sessionId));
        if (!agents.some((a) => a.modelId === params.modelId)) {
          throw Object.assign(new Error(`Unknown A2A agent ${String(params.modelId)}`), {
            code: -32602,
          });
        }
        if (session) session.agent = String(params.modelId);
        return {};
      }
      case "session/prompt": {
        const sessionId = String(params.sessionId);
        const session = sessions.get(sessionId);
        if (!session) throw new Error(`Unknown session ${sessionId}`);
        const controller = new AbortController();
        session.cancel = () => controller.abort();
        try {
          const res = await transport({
            // Context per (session, agent): a context belongs to exactly one peer.
            agent: session.agent,
            message: promptText(params.prompt),
            contextId: contextIdFor(`${sessionId}${session.agent}`),
            signal: controller.signal,
          });
          if (controller.signal.aborted) return { stopReason: "cancelled" };
          send({
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: describeResult(res) },
              },
            },
          });
          return { stopReason: "end_turn" };
        } finally {
          session.cancel = undefined;
        }
      }
      case "session/close":
        sessions.get(String(params.sessionId))?.cancel?.();
        sessions.delete(String(params.sessionId));
        return {};
      case "authenticate":
      case "session/set_mode":
        return {};
      default:
        throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
    }
  }

  return {
    handleLine(line) {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stderr.write("flightplan-a2a ignored a line that is not JSON\n");
        return;
      }
      if (message.method === undefined) return; // responses to requests we never send
      if (message.id === undefined || message.id === null) {
        if (message.method === "session/cancel")
          sessions.get(String(message.params?.sessionId))?.cancel?.();
        return;
      }
      const id = message.id;
      handleRequest(message).then(
        (result) => send({ id, result }),
        (error) =>
          send({
            id,
            error: { code: error.code ?? -32603, message: String(error.message ?? error) },
          }),
      );
    },
  };
}

if (import.meta.main) {
  const agent = createAgent({
    transport: makeTransport(),
    agents: parseAgents(),
    write: (s) => process.stdout.write(s),
  });
  NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (l) =>
    agent.handleLine(l),
  );
}
