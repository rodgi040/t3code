export const PARENT_ORIGIN = "http://localhost:8090";

export interface FlightplanWorkPackage {
  readonly id: number;
  readonly subject: string;
  readonly project?: string;
  readonly status?: string;
  readonly labels?: readonly string[];
  readonly url?: string;
  readonly description?: string;
}

export interface FlightplanQuestion {
  readonly id: number;
  readonly question: string;
  readonly options?: readonly string[];
  readonly context?: string;
  readonly subject?: string;
}

export interface FlightplanAnswer {
  readonly type: "fp:answer";
  readonly id: number;
  readonly option: string;
  readonly text: string;
}

export interface FlightplanChatState {
  readonly context: FlightplanWorkPackage | null;
  readonly questions: readonly FlightplanQuestion[];
  readonly traceId: string | null;
}

const empty: FlightplanChatState = { context: null, questions: [], traceId: null };
let state: FlightplanChatState = empty;
const listeners = new Set<() => void>();

export function acceptParentOrigin(origin: string): boolean {
  return origin === PARENT_ORIGIN;
}

export function answerMessage(id: number, option: string, text: string): FlightplanAnswer {
  return { type: "fp:answer", id, option, text };
}

export function helloMessage(): { readonly type: "fp:hello" } {
  return { type: "fp:hello" };
}

export function applyParentMessage(data: unknown, origin: string): boolean {
  if (!acceptParentOrigin(origin) || data === null || typeof data !== "object") return false;
  const message = data as { type?: unknown; wp?: FlightplanWorkPackage; items?: unknown };
  if (message.type === "fp:context" && message.wp && typeof message.wp.id === "number") {
    state = { ...state, context: message.wp };
    publish();
    return true;
  }
  if (message.type === "fp:questions" && Array.isArray(message.items)) {
    state = {
      ...state,
      questions: message.items.filter(
        (item): item is FlightplanQuestion =>
          item !== null &&
          typeof item === "object" &&
          typeof (item as FlightplanQuestion).id === "number",
      ),
    };
    publish();
    return true;
  }
  return false;
}

function rememberTrace(id: string): void {
  state = { ...state, traceId: id };
  publish();
}

export function withTicketStartContext(text: string): string {
  const wp = state.context;
  if (!wp) return text;
  if (text.includes(`#${wp.id}`)) return text;
  const lines = [
    `Ticket #${wp.id}`,
    `Titel: ${wp.subject}`,
    wp.status ? `Status: ${wp.status}` : "",
    wp.url ? `Link: ${wp.url}` : "",
    wp.description ? `Beschreibung: ${wp.description}` : "",
  ].filter((line) => line.length > 0);
  return `${lines.join("\n")}\n\n${text}`;
}

export function stampClaudeTrace(text: string, instanceId: string | undefined): string {
  if (instanceId !== "claudeAgent" || text.includes("[[fp-trace:")) return text;
  const id = crypto.randomUUID();
  rememberTrace(id);
  return `${text}\n\n[[fp-trace:${id}]]`;
}

export function getFlightplanChat(): FlightplanChatState {
  return state;
}

export function subscribeFlightplanChat(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function installFlightplanChannel(target: Pick<Window, "addEventListener"> = window): void {
  target.addEventListener("message", (event) => {
    applyParentMessage(event.data, event.origin);
  });
  if (target === window && window.parent !== window) {
    window.parent.postMessage(helloMessage(), PARENT_ORIGIN);
  }
}

function publish(): void {
  for (const listener of listeners) listener();
}
