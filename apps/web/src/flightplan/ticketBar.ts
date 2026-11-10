import type { FlightplanEvent } from "./channel";

const CLAIM_MARKER = /fp-claim v1 event=(\w+) session=(\S+?)(?:\s|-->|$)/;
const MACHINE_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const LINE_MAX = 220;

/**
 * Flightplan OP#1784: machine comments (`<!-- fp-op-sync … -->`, claim markers, `claim <session>` notes) become one
 * readable short line or disappear. Plain text only; the caller renders it as a text node.
 */
export function cleanEventText(text: string): string {
  const claim = CLAIM_MARKER.exec(text);
  const plainClaim = /^\s*claim\s+(\S+)\s*$/i.exec(text);
  const rest = text.replace(MACHINE_COMMENT, " ").replace(/\s+/g, " ").trim();
  const summary = claim
    ? `Claim (${claim[1]}): ${claim[2]}`
    : plainClaim
      ? `Claim: ${plainClaim[1]}`
      : "";
  const line = [summary, plainClaim ? "" : rest].filter((part) => part.length > 0).join(" · ");
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
}

/** One cleaned history line for the ticket bar, or null when nothing readable is left. */
export function ticketBarEventLine(event: FlightplanEvent): string | null {
  if (event.kind === "status") return `Status: ${event.from || "–"} → ${event.to || "–"}`;
  const text = cleanEventText(event.text);
  if (!text) return null;
  if (event.kind === "question") return `Rückfrage von ${event.author || "?"}: ${text}`;
  return `${event.author || "?"}${event.source === "chat" ? " (aus Chat)" : ""}: ${text}`;
}

/** "09.11. 21:40" from an ISO time, empty when it does not parse. */
export function eventTime(at: string): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return "";
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}. ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface TicketBarMemory {
  readonly open: boolean;
  /** Open questions the user had seen when choosing; a new one opens the bar again. */
  readonly seen: readonly number[];
}

/** Starts closed, open while a question is open; the user's choice per ticket wins until a new question arrives. */
export function ticketBarOpen(
  memory: TicketBarMemory | null,
  openQuestionIds: readonly number[],
): boolean {
  if (!memory) return openQuestionIds.length > 0;
  if (openQuestionIds.some((id) => !memory.seen.includes(id))) return true;
  return memory.open;
}

const STORAGE_PREFIX = "fp-ticket-bar:";

export function readTicketBarMemory(
  ticketId: number,
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): TicketBarMemory | null {
  try {
    const raw = storage?.getItem(`${STORAGE_PREFIX}${ticketId}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as { open?: unknown; seen?: unknown };
    if (typeof value.open !== "boolean") return null;
    const seen = Array.isArray(value.seen)
      ? value.seen.filter((id): id is number => typeof id === "number")
      : [];
    return { open: value.open, seen };
  } catch {
    return null;
  }
}

export function writeTicketBarMemory(
  ticketId: number,
  memory: TicketBarMemory,
  storage: Pick<Storage, "setItem"> | null = safeStorage(),
): void {
  try {
    storage?.setItem(`${STORAGE_PREFIX}${ticketId}`, JSON.stringify(memory));
  } catch {
    // Storage full or blocked: the bar still works, it just forgets the choice.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Link into OpenProject: relative paths go to the parent origin, other values only when they are http(s). */
export function openProjectLink(url: string | undefined, parentOrigin: string): string | null {
  if (!url) return null;
  if (url.startsWith("/") && !url.startsWith("//")) return `${parentOrigin}${url}`;
  return /^https?:\/\//.test(url) ? url : null;
}
