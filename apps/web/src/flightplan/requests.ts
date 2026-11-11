import type {
  PendingThreadRequests,
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";

import {
  PARENT_ORIGIN,
  TURN_TEXT_MAX_LENGTH,
  assignedThreadId,
  defaultStorage,
  defaultTarget,
  positiveTicket,
  readTicketThreadRecord,
  registerParentHandler,
  sanitizeField,
  type ActivityShell,
  type TicketThreadLookup,
} from "./channel";

// Flightplan OP#1842: open questions and command approvals of a ticket's thread (fp:requests-get / fp:requests) and
// answers from the dashboard (fp:respond / fp:responded). Contract: vertrag-phase3.md sections 1 and 2.

/**
 * The thread's pending requests plus the exact input of every command_execution item in the thread. A command approval
 * is only answerable when its detail equals one of them: that proves detail is the whole command, not a title or a cut summary.
 */
export type PendingSnapshot = PendingThreadRequests & { readonly commands: ReadonlySet<string> };

export type RequestKind = "question" | "approval";
export type RespondResult = "ok" | "gone" | "error";

export interface RequestOption {
  readonly label: string;
  readonly description: string | null;
  readonly recommended: boolean;
}

export interface RequestItem {
  readonly requestId: string;
  readonly kind: RequestKind;
  readonly createdAt: string;
  /** False: more than one question, multiSelect, or the provider cannot take the answer. The dashboard says "im Chat beantworten". */
  readonly answerable: boolean;
  readonly question?: {
    readonly text: string;
    readonly options: readonly RequestOption[];
    readonly multiSelect: boolean;
  };
  readonly approval?: {
    readonly detail: string;
    readonly reason: string | null;
    readonly tool: string | null;
  };
}

export interface FlightplanRequestsMessage {
  readonly type: "fp:requests";
  readonly ticket: number;
  /** null when the server assigns no thread to the ticket. */
  readonly threadId: string | null;
  readonly items: readonly RequestItem[];
}

export interface FlightplanRespondedMessage {
  readonly type: "fp:responded";
  readonly ticket: number;
  readonly requestId: string;
  readonly result: RespondResult;
}

/** What the chat frame offers the channel for requests. FlightplanActivity registers it. */
export interface TicketRequestsHost {
  readonly ready: () => boolean;
  readonly shells: () => ReadonlyArray<
    ActivityShell & {
      readonly hasPendingApprovals?: boolean;
      readonly hasPendingUserInput?: boolean;
    }
  >;
  /**
   * Loads the thread's detail (also when it is not the open one) and reports its pending requests on every change;
   * null until the detail has arrived. Returns the function that releases the detail again, or null for an unknown thread.
   */
  readonly watch: (
    threadId: string,
    onChange: (pending: PendingSnapshot | null) => void,
  ) => (() => void) | null;
  /** respondToThreadApproval with an explicit threadId. Only "accept" and "decline" ever arrive here. */
  readonly respondApproval: (
    threadId: string,
    requestId: string,
    decision: "accept" | "decline",
  ) => Promise<boolean>;
  /** respondToThreadUserInput with an explicit threadId. */
  readonly respondUserInput: (
    threadId: string,
    requestId: string,
    answers: Record<string, string>,
  ) => Promise<boolean>;
}

interface RequestDeps {
  readonly host?: TicketRequestsHost | null;
  readonly target?: Pick<Window, "postMessage"> | null;
  readonly lookup?: TicketThreadLookup;
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

export const REQUESTS_QUERIED_MAX = 50;
export const REQUESTS_WATCH_MAX = 12;
const FIRST_DATA_TIMEOUT_MS = 8000;
const RESPOND_SNAPSHOT_TIMEOUT_MS = 5000;
const ID_MAX = 200;
const OPTION_LABEL_MAX = 500;
const ANSWERED_STORE_KEY = "fp:responded";
const ANSWERED_MAX = 200;

let requestsHost: TicketRequestsHost | null = null;

export function setTicketRequestsHost(host: TicketRequestsHost | null): void {
  requestsHost = host;
}

const RECOMMENDED_SUFFIX = /\s*\((?:recommended|empfohlen)\)\s*$/i;

/** "(Recommended)" or "(Empfohlen)" at the end of the label; the label itself is passed on unchanged. */
export function isRecommendedLabel(label: string): boolean {
  return RECOMMENDED_SUFFIX.test(label);
}

export function userInputAnswerable(input: ThreadPendingUserInput): boolean {
  if (input.responseCapability !== "live") return false;
  if (input.questions.length !== 1) return false;
  const question = input.questions[0];
  if (!question || question.multiSelect) return false;
  return question.options.length > 0 || question.allowCustomAnswer !== false;
}

// Bidi controls, zero-width characters and every control character except \n and \t can make a command read differently than it runs.
const DECEPTIVE_CHARS =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
export const APPROVAL_DETAIL_MAX = 8000;

export function approvalAnswerable(
  approval: ThreadPendingApproval,
  commands: ReadonlySet<string>,
): boolean {
  if (approval.responseCapability !== "live") return false;
  // Only a shell command; every other request (and Codex with a reason, Claude's title or 400-char summary) shows other text.
  if (approval.requestKind !== "command") return false;
  // Never approve what the human could not read in full.
  if (
    approval.detail &&
    (approval.detail.length > APPROVAL_DETAIL_MAX || DECEPTIVE_CHARS.test(approval.detail))
  )
    return false;
  if (!approval.detail || !commands.has(approval.detail.trim())) return false;
  if (approval.options === undefined) return true;
  const offered = new Set(approval.options.map((option) => option.decision));
  return offered.has("accept") && offered.has("decline");
}

function questionItem(input: ThreadPendingUserInput): RequestItem {
  const question = input.questions[0];
  return {
    requestId: input.requestId,
    kind: "question",
    createdAt: input.createdAt,
    answerable: userInputAnswerable(input),
    question: {
      text: question?.question ?? "",
      options: (question?.options ?? []).map((option) => ({
        label: option.label,
        description: option.description || null,
        recommended: isRecommendedLabel(option.label),
      })),
      multiSelect: input.questions.length > 1 || Boolean(question?.multiSelect),
    },
  };
}

function approvalItem(approval: ThreadPendingApproval, commands: ReadonlySet<string>): RequestItem {
  return {
    requestId: approval.requestId,
    kind: "approval",
    createdAt: approval.createdAt,
    answerable: approvalAnswerable(approval, commands),
    approval: {
      detail: approval.detail ?? "",
      reason: approval.reason ?? null,
      tool: approval.appName ?? approval.requestKind ?? null,
    },
  };
}

/** Pure mapping of the thread's pending requests to the wire items, oldest first. */
export function requestItems(pending: PendingSnapshot): RequestItem[] {
  return [
    ...pending.userInputs.map(questionItem),
    ...pending.approvals.map((approval) => approvalItem(approval, pending.commands)),
  ].toSorted(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.requestId.localeCompare(b.requestId),
  );
}

interface Watch {
  readonly threadId: string;
  unsubscribe: () => void;
  pending: PendingSnapshot | null;
  /** The parent asked and has not been answered yet. */
  awaitingFirst: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

// Tickets the dashboard asked for -> the thread the server assigned when asked.
const queried = new Map<number, string | null>();
const watches = new Map<number, Watch>();
const lastSent = new Map<number, string>();
const answered = new Set<string>();
const inFlight = new Set<string>();

/** For tests: forgets queried tickets, watches and answered requests. */
export function resetTicketRequests(): void {
  for (const watch of watches.values()) {
    if (watch.timer) clearTimeout(watch.timer);
    watch.unsubscribe();
  }
  watches.clear();
  queried.clear();
  lastSent.clear();
  answered.clear();
  inFlight.clear();
}

function post(
  target: Pick<Window, "postMessage"> | null,
  ticket: number,
  threadId: string | null,
  items: readonly RequestItem[],
  force: boolean,
): void {
  const message: FlightplanRequestsMessage = { type: "fp:requests", ticket, threadId, items };
  const key = JSON.stringify(message);
  if (!force && lastSent.get(ticket) === key) return;
  lastSent.set(ticket, key);
  target?.postMessage(message, PARENT_ORIGIN);
}

function dropWatch(ticket: number): void {
  const watch = watches.get(ticket);
  if (!watch) return;
  if (watch.timer) clearTimeout(watch.timer);
  watch.unsubscribe();
  watches.delete(ticket);
}

function rememberQueried(ticket: number, threadId: string | null): void {
  queried.delete(ticket);
  queried.set(ticket, threadId);
  while (queried.size > REQUESTS_QUERIED_MAX) {
    const oldest = queried.keys().next().value;
    if (oldest === undefined) break;
    queried.delete(oldest);
    dropWatch(oldest);
    lastSent.delete(oldest);
  }
}

function shellWaits(shell: {
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
}): boolean {
  return Boolean(shell.hasPendingApprovals) || Boolean(shell.hasPendingUserInput);
}

function startWatch(
  host: TicketRequestsHost,
  ticket: number,
  threadId: string,
  target: Pick<Window, "postMessage"> | null,
  awaitingFirst: boolean,
): boolean {
  if (watches.size >= REQUESTS_WATCH_MAX) return false;
  const watch: Watch = {
    threadId,
    unsubscribe: () => undefined,
    pending: null,
    awaitingFirst,
    timer: null,
  };
  // Registered first: the registry calls back synchronously with the current value.
  watches.set(ticket, watch);
  const unsubscribe = host.watch(threadId, (pending) => {
    if (pending === null || watches.get(ticket) !== watch) return;
    watch.pending = pending;
    const force = watch.awaitingFirst;
    watch.awaitingFirst = false;
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = null;
    post(target, ticket, threadId, requestItems(pending), force);
  });
  if (!unsubscribe) {
    watches.delete(ticket);
    return false;
  }
  watch.unsubscribe = unsubscribe;
  if (awaitingFirst && watch.pending === null) {
    // The detail did not arrive in time: tell the dashboard there is nothing it can show; a later arrival still re-sends.
    watch.timer = setTimeout(() => {
      watch.timer = null;
      if (!watch.awaitingFirst) return;
      watch.awaitingFirst = false;
      post(target, ticket, threadId, [], true);
    }, FIRST_DATA_TIMEOUT_MS);
  }
  return true;
}

/**
 * fp:requests-get: the open requests of the ticket's thread, even when it is not the open one. Replies with fp:requests
 * and keeps sending it when they change (see refreshRequestWatches) for as long as the ticket is remembered.
 */
export async function handleRequestsGet(ticket: number, deps: RequestDeps = {}): Promise<void> {
  const host = deps.host === undefined ? requestsHost : deps.host;
  const target = deps.target === undefined ? defaultTarget() : deps.target;
  const lookup = deps.lookup ?? readTicketThreadRecord;
  const threadId = await assignedThreadId(ticket, lookup);
  rememberQueried(ticket, threadId);
  if (!threadId) {
    dropWatch(ticket);
    return post(target, ticket, null, [], true);
  }
  // Threads not loaded yet: nothing is known. The next beat (refreshRequestWatches) answers once they are.
  if (!host || !host.ready()) return;
  const shell = host.shells().find((item) => item.id === threadId);
  if (!shell || !shellWaits(shell)) {
    dropWatch(ticket);
    return post(target, ticket, threadId, [], true);
  }
  const existing = watches.get(ticket);
  if (existing && existing.threadId === threadId) {
    if (existing.pending)
      return post(target, ticket, threadId, requestItems(existing.pending), true);
    existing.awaitingFirst = true;
    return;
  }
  dropWatch(ticket);
  if (!startWatch(host, ticket, threadId, target, true)) post(target, ticket, threadId, [], true);
}

/**
 * Called from the activity beat (on shell change and every 30 s; `recheck` also asks the server for the thread again).
 * Keeps one detail subscription per queried ticket whose thread waits for the human, sends fp:requests when the
 * open requests changed and releases the subscription once nothing is open.
 */
export async function refreshRequestWatches(
  deps: RequestDeps & { readonly recheck?: boolean } = {},
): Promise<void> {
  const host = deps.host === undefined ? requestsHost : deps.host;
  const target = deps.target === undefined ? defaultTarget() : deps.target;
  const lookup = deps.lookup ?? readTicketThreadRecord;
  if (!host || !host.ready()) return;
  const shells = host.shells();
  for (const [ticket, known] of queried) {
    const threadId = known && !deps.recheck ? known : await assignedThreadId(ticket, lookup);
    if (!queried.has(ticket)) continue;
    if (threadId !== known) queried.set(ticket, threadId);
    const shell = threadId ? shells.find((item) => item.id === threadId) : undefined;
    if (!threadId || !shell || !shellWaits(shell)) {
      dropWatch(ticket);
      post(target, ticket, threadId, [], false);
      continue;
    }
    const watch = watches.get(ticket);
    if (watch && watch.threadId !== threadId) dropWatch(ticket);
    if (!watches.has(ticket)) startWatch(host, ticket, threadId, target, false);
  }
}

export type ParsedRespond =
  | {
      readonly kind: "question";
      readonly ticket: number;
      readonly threadId: string;
      readonly requestId: string;
      readonly optionLabel: string | null;
      readonly text: string | null;
    }
  | {
      readonly kind: "approval";
      readonly ticket: number;
      readonly threadId: string;
      readonly requestId: string;
      readonly decision: "accept" | "decline";
      /** The command text the dashboard showed; null when the message carries none. */
      readonly detail: string | null;
    };

function idField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= ID_MAX ? value : null;
}

/** Strict validation: unknown kinds, decisions other than accept/decline, both or neither of optionLabel/text -> null. */
export function parseRespond(data: unknown): ParsedRespond | null {
  const message = data as Record<string, unknown> | null;
  const ticket = positiveTicket(message?.ticket);
  const threadId = idField(message?.threadId);
  const requestId = idField(message?.requestId);
  if (ticket === null || threadId === null || requestId === null) return null;
  if (message?.kind === "approval") {
    const decision = message.decision;
    if (decision !== "accept" && decision !== "decline") return null;
    const detail = typeof message.detail === "string" ? message.detail : null;
    return { kind: "approval", ticket, threadId, requestId, decision, detail };
  }
  if (message?.kind !== "question") return null;
  const hasLabel = message.optionLabel !== undefined && message.optionLabel !== null;
  const hasText = message.text !== undefined && message.text !== null;
  if (hasLabel === hasText) return null;
  if (hasLabel) {
    const label = message.optionLabel;
    if (typeof label !== "string" || label.length === 0 || label.length > OPTION_LABEL_MAX)
      return null;
    return { kind: "question", ticket, threadId, requestId, optionLabel: label, text: null };
  }
  if (typeof message.text !== "string" || message.text.length > TURN_TEXT_MAX_LENGTH) return null;
  const text = sanitizeField(message.text, TURN_TEXT_MAX_LENGTH, true);
  if (!text) return null;
  return { kind: "question", ticket, threadId, requestId, optionLabel: null, text };
}

function replyResponded(
  target: Pick<Window, "postMessage"> | null,
  ticket: number,
  requestId: string,
  result: RespondResult,
): void {
  const message: FlightplanRespondedMessage = { type: "fp:responded", ticket, requestId, result };
  target?.postMessage(message, PARENT_ORIGIN);
}

function readAnswered(storage: Pick<Storage, "getItem"> | null): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(ANSWERED_STORE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function writeAnswered(storage: Pick<Storage, "setItem"> | null, keys: string[]): void {
  try {
    storage?.setItem(ANSWERED_STORE_KEY, JSON.stringify(keys.slice(-ANSWERED_MAX)));
  } catch {
    // Without sessionStorage the in-memory set still guards this page load.
  }
}

/** The thread's current pending requests: the live watch when the ticket has one, else one short-lived read. */
function currentPending(
  host: TicketRequestsHost,
  ticket: number,
  threadId: string,
): Promise<PendingSnapshot | null> {
  const watch = watches.get(ticket);
  if (watch && watch.threadId === threadId && watch.pending) return Promise.resolve(watch.pending);
  return new Promise((resolve) => {
    let done = false;
    let release: (() => void) | null = null;
    const finish = (value: PendingSnapshot | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // The callback may run before watch() has returned the release function.
      if (release) release();
      else queueMicrotask(() => release?.());
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), RESPOND_SNAPSHOT_TIMEOUT_MS);
    release = host.watch(threadId, (pending) => {
      if (pending !== null) finish(pending);
    });
    if (release === null) finish(null);
  });
}

/**
 * fp:respond: answers exactly one open request of the ticket's thread, once. Question: an offered option (exact label)
 * or free text. Approval: only the one-time "accept" or "decline" (never acceptForSession/acceptAlways, no mode change).
 */
export async function handleRespond(request: ParsedRespond, deps: RequestDeps = {}): Promise<void> {
  const host = deps.host === undefined ? requestsHost : deps.host;
  const target = deps.target === undefined ? defaultTarget() : deps.target;
  const lookup = deps.lookup ?? readTicketThreadRecord;
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const reply = (result: RespondResult) =>
    replyResponded(target, request.ticket, request.requestId, result);
  const key = `${request.threadId}\u0000${request.requestId}`;
  if (!host || !host.ready()) return reply("error");
  // Thread and ticket belong together only by the server's record, never by what the message claims.
  const assigned = await assignedThreadId(request.ticket, lookup);
  if (assigned === null || assigned !== request.threadId) return reply("error");
  const shell = host.shells().find((item) => item.id === request.threadId);
  if (!shell) return reply("error");
  if (inFlight.has(key) || answered.has(key) || readAnswered(storage).includes(key))
    return reply("gone");
  inFlight.add(key);
  let delivered = false;
  try {
    const pending = await currentPending(host, request.ticket, request.threadId);
    if (!pending) return reply("error");
    const input = pending.userInputs.find((item) => item.requestId === request.requestId);
    const approval = pending.approvals.find((item) => item.requestId === request.requestId);
    if (!input && !approval) return reply("gone");
    let ok: boolean;
    if (request.kind === "question") {
      if (!input || !userInputAnswerable(input)) return reply("error");
      const question = input.questions[0];
      if (!question) return reply("error");
      let answer: string;
      if (request.optionLabel !== null) {
        const option = question.options.find((item) => item.label === request.optionLabel);
        if (!option) return reply("error");
        answer = option.value ?? option.label;
      } else {
        if (question.allowCustomAnswer === false || request.text === null) return reply("error");
        answer = request.text;
      }
      // Marked before the send; a failed send undoes the mark below.
      answered.add(key);
      ok = await host.respondUserInput(request.threadId, request.requestId, {
        [question.id]: answer,
      });
    } else {
      if (!approval || !approvalAnswerable(approval, pending.commands)) return reply("error");
      // What the human approved must be exactly what is open now; anything else releases nothing.
      if (request.detail === null || request.detail !== approval.detail) return reply("gone");
      answered.add(key);
      ok = await host.respondApproval(request.threadId, request.requestId, request.decision);
    }
    delivered = ok;
    if (ok) return reply("ok");
    // Answered elsewhere in the meantime: the live watch no longer lists it.
    const still = watches.get(request.ticket)?.pending;
    const open =
      still?.userInputs.some((i) => i.requestId === request.requestId) ||
      still?.approvals.some((a) => a.requestId === request.requestId);
    return reply(still && !open ? "gone" : "error");
  } catch {
    return reply("error");
  } finally {
    inFlight.delete(key);
    if (delivered) writeAnswered(storage, [...readAnswered(storage), key]);
    else answered.delete(key);
  }
}

registerParentHandler("fp:requests-get", (data) => {
  const ticket = positiveTicket((data as { ticket?: unknown }).ticket);
  if (ticket === null) return false;
  void handleRequestsGet(ticket);
  return true;
});

registerParentHandler("fp:respond", (data) => {
  const request = parseRespond(data);
  if (request === null) {
    // A well-formed ticket and requestId still get an answer; anything else is dropped silently.
    const raw = data as { ticket?: unknown; requestId?: unknown };
    const ticket = positiveTicket(raw.ticket);
    const requestId = idField(raw.requestId);
    if (ticket !== null && requestId !== null)
      replyResponded(defaultTarget(), ticket, requestId, "error");
    return false;
  }
  void handleRespond(request);
  return true;
});
