import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

const TICKET = /#(\d+)/g;
const TRACE_MARKER = /\[\[fp-trace:([0-9a-f-]{36})\]\]/gi;
const SLASH_COMMAND = /^\/[a-z][\w-]*(?:\s|$)/i;
const CAP = 8_000;

export function ticketIds(text: string): string[] {
  return [...new Set([...text.matchAll(TICKET)].map((match) => match[1] ?? ""))].filter(Boolean);
}

// Flightplan OP#1720: the web client prepends this block to a ticket start.
export function hasTicketContextBlock(text: string): boolean {
  return /^\s*<ticket-context[^>]*>/.test(text);
}

export function takeTraceMarker(text: string): { text: string; traceId: string | null } {
  const match = [...text.matchAll(TRACE_MARKER)][0];
  return {
    text: text.replace(TRACE_MARKER, "").trimEnd(),
    traceId: match?.[1] ?? null,
  };
}

// Flightplan OP#1803: `/goal clear`, `/compact` and friends are parsed by the provider from the whole prompt.
export function isSlashCommand(text: string): boolean {
  return SLASH_COMMAND.test(text.trimStart());
}

function withTicketContext(
  text: string,
  blocks: readonly { id: string; ok: boolean; body: string }[],
): string {
  if (blocks.length === 0) return text;
  const extra = blocks
    .map((block) =>
      block.ok
        ? `Ticket #${block.id}\n${block.body}`
        : `Ticket #${block.id} konnte nicht geladen werden.`,
    )
    .join("\n\n");
  return `${text}\n\n${extra}`;
}

function withClaudeHint(text: string, driver: string): string {
  if (driver !== "claudeAgent" || text.includes("CLI fp-op")) return text;
  return `${text}\n\nTicket actions in this session go through the CLI fp-op (host tool, docs/agents/fp-op.md).`;
}

function runFpOp(id: string): Promise<{ id: string; ok: boolean; body: string }> {
  const bin = process.env.FP_OP_BIN || "fp-op";
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(bin, ["get", id], {
      env: { ...process.env, FP_OP_USER: "claude" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > CAP + 1_000) child.kill();
    });
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      resolve({ id, ok, body: out.slice(0, CAP) });
    };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

async function openClaudeTrace(traceId: string, threadId?: string): Promise<string | null> {
  const path = process.env.FP_LANGFUSE_ENV || "/root/.config/fp-langfuse-sender/env";
  if (!NodeFS.existsSync(path)) return null;
  let publicKey = "";
  let secretKey = "";
  let host = "http://127.0.0.1:3200";
  try {
    for (const line of NodeFS.readFileSync(path, "utf8").split("\n")) {
      const split = line.indexOf("=");
      if (split <= 0) continue;
      const key = line.slice(0, split).trim();
      const value = line.slice(split + 1).trim();
      if (key === "LANGFUSE_PUBLIC_KEY") publicKey = value;
      if (key === "LANGFUSE_SECRET_KEY") secretKey = value;
      if (key === "LANGFUSE_HOST") host = value;
    }
  } catch {
    return null;
  }
  if (!publicKey || !secretKey) return null;
  const id = traceId || NodeCrypto.randomUUID();
  const body = {
    batch: [
      {
        id,
        type: "trace-create",
        timestamp: new Date().toISOString(),
        body: {
          id,
          name: "t3-fp-claude",
          ...(threadId ? { sessionId: threadId } : {}),
          metadata: { source: "t3-fp", ...(threadId ? { threadId } : {}) },
        },
      },
    ],
  };
  try {
    const response = await fetch(`${host.replace(/\/$/, "")}/api/public/ingestion`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return response.ok ? id : null;
  } catch {
    return null;
  }
}

/**
 * Flightplan OP#1803: the session context (fp-op hint, trace id) goes to the agent once, with the first turn of a
 * thread. Later turns and slash commands reach the provider without additions; the Langfuse trace of a later turn is
 * tied to the thread through its metadata instead of the prompt text.
 */
export async function enrichFlightplanPrompt(input: {
  text: string;
  driver: string;
  firstTurn: boolean;
  threadId?: string;
  run?: (id: string) => Promise<{ id: string; ok: boolean; body: string }>;
  trace?: (id: string, threadId?: string) => Promise<string | null>;
}): Promise<string> {
  const marked = takeTraceMarker(input.text);
  if (isSlashCommand(marked.text)) return marked.text;
  const ids = ticketIds(marked.text);
  const run = input.run ?? runFpOp;
  const blocks = [];
  for (const id of ids) blocks.push(await run(id));
  const text = withTicketContext(marked.text, blocks);
  if (input.driver !== "claudeAgent") return text;
  const traceId = marked.traceId ?? NodeCrypto.randomUUID();
  const opened = await (input.trace ?? openClaudeTrace)(traceId, input.threadId);
  if (!input.firstTurn) return text;
  const hinted = withClaudeHint(text, input.driver);
  return opened ? `${hinted}\n\nTrace: ${opened}` : hinted;
}
