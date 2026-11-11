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

// Flightplan OP#1853: UUID or 32 hex in, 32 lowercase hex out; anything else (or all zeros) is no trace id.
export function normalizeTraceId(value: string): string | null {
  const hex = value.replaceAll("-", "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) && !/^0+$/.test(hex) ? hex : null;
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

// Flightplan OP#1838: the rule is off unless T3CODE_FP_ASSUMPTION_RULE=1 (same plain env read as FP_OP_BIN above).
const BLOCK_TICKET = /^\s*<ticket-context[^>]*>\nTicket #(\d+)(?:\n|<)/;
const START_TICKET = /^\s*Ticket #(\d+) wurde im ADA-Dashboard geöffnet\./;

/** Ticket number only from the fixed start of the turn (context block or dashboard start turn), never from free text. */
export function startTurnTicket(text: string): string | undefined {
  return (BLOCK_TICKET.exec(text) ?? START_TICKET.exec(text))?.[1];
}

function assumptionRuleEnabled(): boolean {
  return process.env.T3CODE_FP_ASSUMPTION_RULE === "1";
}

// Flightplan OP#1838: decide inside the approved plan, record the assumption on the ticket, ask about reserved topics.
function assumptionRule(ticket: string): string {
  return [
    "Regeln für Entscheidungen in diesem Ticket:",
    "- Entscheidungen innerhalb des freigegebenen Plans und Scopes des Tickets triffst du selbst. Frag dafür nicht nach.",
    `- Halte jede solche Entscheidung, die der Mensch anders sehen könnte, als Annahme fest: fp-op assume ${ticket} --text "…". Es darf nur eine Annahme offen sein; ist schon eine offen (Exit 2), stell eine Rückfrage statt einer zweiten Annahme.`,
    "- Solange eine Annahme offen ist: arbeite nur in deinem Branch und merge nicht.",
    "- Immer Rückfrage an den Menschen, nie Annahme: Deploy, Release, Einspielen; Host, Docker, Firewall, SSH, Ports, DNS; Secrets und Rotation; Löschen und alles Unumkehrbare; Geld, Budget, Modellwahl; Kunden, Versand, Verträge; Scope und Priorität; Architektur und Zuständigkeit; Prüfer-Befunde; Überspringen eines Gates.",
    `- Rückfragen stellst du so: fp-op ask ${ticket} --question "…" --option "…" (mehrfach) --recommend "<Option>" --kind entscheidung|freigabe|zugang|abnahme und --reversible oder --irreversible.`,
    `- Am Ende der Arbeit: fp-op result ${ticket} --stdin mit den Abschnitten Geändert, Geprüft, Offen.`,
  ].join("\n");
}

function withClaudeHint(text: string, driver: string, ticket?: string): string {
  if (driver !== "claudeAgent" || text.includes("CLI fp-op")) return text;
  const hint = `${text}\n\nTicket actions in this session go through the CLI fp-op (host tool, docs/agents/fp-op.md).`;
  return ticket ? `${hint}\n\n${assumptionRule(ticket)}` : hint;
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

const SPAN_NAME = "t3-fp-claude";
const SERVICE = "t3-fp";

type OtlpValue =
  | { stringValue: string }
  | { arrayValue: { values: Array<{ stringValue: string }> } };

function otlpAttrs(
  entries: Record<string, string | string[]>,
): Array<{ key: string; value: OtlpValue }> {
  return Object.entries(entries).map(([key, value]) => ({
    key,
    value: Array.isArray(value)
      ? { arrayValue: { values: value.map((stringValue) => ({ stringValue })) } }
      : { stringValue: value },
  }));
}

/**
 * Flightplan OP#1853: OTLP/JSON body of one turn span (shape of claude_code_sender.py). Identifiers only, no prompt or
 * answer text: the input has no free text or metadata field.
 */
export function buildTurnSpanBody(input: {
  traceId: string;
  spanId: string;
  nowMs: number;
  threadId?: string;
  ticket?: string;
}) {
  const ticket = input.ticket && /^\d+$/.test(input.ticket) ? input.ticket : undefined;
  const nanos = (BigInt(input.nowMs) * 1_000_000n).toString();
  const attributes = otlpAttrs({
    ...(input.threadId ? { "langfuse.session.id": input.threadId } : {}),
    "langfuse.trace.name": SPAN_NAME,
    "langfuse.observation.type": "span",
    "langfuse.trace.tags": ["harness:t3-fp", ...(ticket ? [`ticket:${ticket}`] : [])],
    "langfuse.trace.metadata.source": SERVICE,
    ...(input.threadId ? { "langfuse.trace.metadata.thread_id": input.threadId } : {}),
    ...(ticket ? { "langfuse.trace.metadata.fp_issue": ticket } : {}),
  });
  return {
    resourceSpans: [
      {
        resource: {
          attributes: otlpAttrs({ "service.name": SERVICE, "langfuse.environment": SERVICE }),
        },
        scopeSpans: [
          {
            scope: { name: SERVICE },
            spans: [
              {
                traceId: input.traceId,
                spanId: input.spanId,
                name: SPAN_NAME,
                kind: 1,
                startTimeUnixNano: nanos,
                endTimeUnixNano: nanos,
                attributes,
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Flightplan OP#1853: one OTLP span per Claude turn to Langfuse; fail-open, returns the trace id only on 2xx. */
export async function sendTurnSpan(
  traceId: string,
  threadId?: string,
  ticket?: string,
): Promise<string | null> {
  const id = normalizeTraceId(traceId);
  if (!id) return null;
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
  const body = buildTurnSpanBody({
    traceId: id,
    spanId: NodeCrypto.randomBytes(8).toString("hex"),
    // Plain promise code outside the Effect runtime, so no Clock service here.
    // @effect-diagnostics-next-line globalDate:off
    nowMs: Date.now(),
    ...(threadId ? { threadId } : {}),
    ...(ticket ? { ticket } : {}),
  });
  try {
    const response = await fetch(`${host.replace(/\/$/, "")}/api/public/otel/v1/traces`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
        "content-type": "application/json",
        "x-langfuse-ingestion-version": "4",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
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
  /** Flightplan OP#1853: ticket of the thread from the mapping file, read by the caller. */
  ticket?: string;
  run?: (id: string) => Promise<{ id: string; ok: boolean; body: string }>;
  trace?: (id: string, threadId?: string, ticket?: string) => Promise<string | null>;
}): Promise<string> {
  const marked = takeTraceMarker(input.text);
  if (isSlashCommand(marked.text)) return marked.text;
  const ids = ticketIds(marked.text);
  const run = input.run ?? runFpOp;
  const blocks = [];
  for (const id of ids) blocks.push(await run(id));
  const text = withTicketContext(marked.text, blocks);
  if (input.driver !== "claudeAgent") return text;
  const traceId =
    (marked.traceId ? normalizeTraceId(marked.traceId) : null) ??
    NodeCrypto.randomUUID().replaceAll("-", "");
  const startTicket = startTurnTicket(marked.text);
  const opened = await (input.trace ?? sendTurnSpan)(
    traceId,
    input.threadId,
    input.ticket ?? startTicket,
  );
  if (!input.firstTurn) return text;
  const hinted = withClaudeHint(
    text,
    input.driver,
    assumptionRuleEnabled() ? startTicket : undefined,
  );
  return opened ? `${hinted}\n\nTrace: ${opened}` : hinted;
}
