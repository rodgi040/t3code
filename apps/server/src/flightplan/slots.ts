// Flightplan OP#1889: at most four ticket threads work at the same time, enforced when a turn starts.
// No queue and no automatic restart: the refused turn ends with a readable message and the person sends again.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Shape } from "../orchestration-v2/ProjectionStore.ts";
import { readTicketThreadMap, ticketForThread } from "./ticketThreads.ts";

const DEFAULT_SLOT_LIMIT = 4;

/** `T3CODE_FP_SLOT_LIMIT`: unset or invalid gives 4, `0` switches the check off. */
export function slotLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = env.T3CODE_FP_SLOT_LIMIT?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return DEFAULT_SLOT_LIMIT;
  return Number(raw);
}

/** A run that holds a slot: the provider is preparing, starting or running. Waiting for a person does not. */
function isWorkingStatus(status: string | null | undefined): boolean {
  return status === "preparing" || status === "starting" || status === "running";
}

export interface SlotCandidate {
  readonly ticket: string;
  readonly threadId: string;
  readonly status: string | null;
  readonly requestedAtMs: number | null;
}

export interface SlotSelf {
  readonly threadId: string;
  readonly requestedAtMs: number | null;
}

export type SlotDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly tickets: ReadonlyArray<string>; readonly message: string };

const COUNT_WORDS: Record<number, string> = {
  2: "Zwei",
  3: "Drei",
  4: "Vier",
  5: "Fünf",
  6: "Sechs",
};

export function slotRefusalMessage(tickets: ReadonlyArray<string>): string {
  const count = tickets.length;
  const list = tickets.map((ticket) => `#${ticket}`).join(", ");
  const head =
    count === 1
      ? `Ein Ticket-Thread arbeitet bereits (${list}).`
      : `${COUNT_WORDS[count] ?? String(count)} Ticket-Threads arbeiten bereits (${list}).`;
  return `${head} Dieser Turn wurde nicht gestartet. Bitte sende ihn erneut, sobald ein Platz frei ist.`;
}

/**
 * A running thread always holds a slot. A thread that is only starting holds one for this start
 * when it asked first (earlier request, thread id as tie-break), so two simultaneous starts do not
 * both refuse each other and the later one sees the earlier one.
 */
function holdsSlotAgainst(candidate: SlotCandidate, self: SlotSelf): boolean {
  if (!isWorkingStatus(candidate.status)) return false;
  if (candidate.status === "running") return true;
  if (candidate.requestedAtMs === null || self.requestedAtMs === null) return true;
  if (candidate.requestedAtMs !== self.requestedAtMs)
    return candidate.requestedAtMs < self.requestedAtMs;
  return candidate.threadId < self.threadId;
}

export function evaluateSlots(input: {
  readonly limit: number;
  readonly self: SlotSelf;
  readonly candidates: ReadonlyArray<SlotCandidate>;
}): SlotDecision {
  if (input.limit <= 0) return { allowed: true };
  const holding = input.candidates
    .filter((candidate) => candidate.threadId !== input.self.threadId)
    .filter((candidate) => holdsSlotAgainst(candidate, input.self));
  if (holding.length < input.limit) return { allowed: true };
  const tickets = holding
    .map((candidate) => candidate.ticket)
    .toSorted((a, b) => Number(a) - Number(b));
  return { allowed: false, tickets, message: slotRefusalMessage(tickets) };
}

/**
 * Decision for the turn that is starting. Never fails: a mapping or store read error lets the turn
 * run (logged as a warning), because a failing guard would hang every agent.
 */
export const checkTicketSlot = Effect.fn("Flightplan.checkTicketSlot")(
  function* (input: {
    readonly mapFile: () => string;
    readonly threadId: string;
    readonly requestedAt: DateTime.Utc | null;
    /** Other runs of the same thread: a thread that already works is only continued. */
    readonly otherRunStatuses: ReadonlyArray<string>;
    readonly store: Pick<ProjectionStoreV2Shape, "listActiveShellIndex" | "getThreadShell">;
    readonly env?: Record<string, string | undefined>;
  }) {
    const limit = slotLimit(input.env);
    if (limit <= 0) return { allowed: true } as const;
    const map = readTicketThreadMap(input.mapFile());
    // A free chat has no ticket: not counted, not limited.
    if (ticketForThread(map, input.threadId) === undefined) return { allowed: true } as const;
    if (input.otherRunStatuses.some(isWorkingStatus)) return { allowed: true } as const;
    const byThread = new Map(
      Object.entries(map).map(([ticket, record]) => [record.threadId, ticket]),
    );
    const live = (yield* input.store.listActiveShellIndex()).filter(
      (entry) => entry.mayBeLive && byThread.has(entry.id) && entry.id !== input.threadId,
    );
    const candidates: Array<SlotCandidate> = [];
    for (const entry of live) {
      const shell = yield* input.store.getThreadShell(entry.id);
      if (shell === null) continue;
      const status = shell.activityRunStatus ?? null;
      if (!isWorkingStatus(status)) continue;
      candidates.push({
        ticket: byThread.get(entry.id)!,
        threadId: entry.id,
        status,
        requestedAtMs:
          shell.latestRunRequestedAt === null || shell.latestRunRequestedAt === undefined
            ? null
            : DateTime.toEpochMillis(shell.latestRunRequestedAt),
      });
    }
    return evaluateSlots({
      limit,
      self: {
        threadId: input.threadId,
        requestedAtMs:
          input.requestedAt === null ? null : DateTime.toEpochMillis(input.requestedAt),
      },
      candidates,
    });
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Flightplan slot check failed; the turn starts anyway", {
          threadId: input.threadId,
          cause: String(cause),
        }).pipe(Effect.as({ allowed: true } as const)),
      ),
    ),
);
