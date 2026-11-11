/**
 * Flightplan OP#1887: `<baseDir>/userdata/flightplan-waiting.json` lists ticket threads waiting on the human
 * (approval, input, error), derived from the server's own thread shells with the web client's rules. Read-only
 * information; `T3CODE_FP_WAITING_FILE=0` switches it off.
 */
// @effect-diagnostics nodeBuiltinImport:off - plain synchronous Node file code outside the Effect runtime (Flightplan module).
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { readTicketThreadMap, ticketThreadFile } from "./ticketThreads.ts";

const WAITING_FILE_ENV = "T3CODE_FP_WAITING_FILE";
const WAITING_FILE_NAME = "flightplan-waiting.json";
/** At most one write per this many milliseconds. */
const WAITING_MIN_INTERVAL_MS = 10_000;
/** The file is rewritten at least this often, so a reader can treat an old `written_at` as a dead server. */
const WAITING_HEARTBEAT_MS = 60_000;
const SUMMARY_MAX = 200;

export type WaitingState = "approval" | "input" | "error";

export interface WaitingThread {
  readonly ticket: number;
  readonly threadId: string;
  readonly state: WaitingState;
  readonly since: string;
  readonly summary: string;
}

export interface WaitingFile {
  readonly version: 1;
  readonly written_at: string;
  readonly threads: ReadonlyArray<WaitingThread>;
}

/** On by default. `0` (or `false`) switches the file off. */
export function waitingFileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[WAITING_FILE_ENV]?.trim().toLowerCase();
  return value !== "0" && value !== "false";
}

export function waitingFilePath(baseDir: string): string {
  return NodePath.join(NodePath.dirname(ticketThreadFile(baseDir)), WAITING_FILE_NAME);
}

export type WaitingShellInput = Pick<
  OrchestrationV2ThreadShell,
  | "status"
  | "activityRunStatus"
  | "activeProviderThreadId"
  | "latestRunId"
  | "latestRunCompletedAt"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "lastErrorClass"
  | "updatedAt"
>;

// Same rules as the web client (packages/client-runtime/src/state/models.ts: shellRuntime,
// shellHasPendingUserInput, hasPendingApprovals; apps/web/src/flightplan/channel.ts: shellActivityState).
export function deriveWaitingState(
  shell: WaitingShellInput,
): { readonly state: WaitingState; readonly since: string; readonly summary: string } | null {
  const parkAtIdle =
    backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? []) && shell.status !== "failed";
  const hasRuntime =
    shell.latestRunId !== null || shell.activeProviderThreadId !== null || parkAtIdle;
  const runStatus = hasRuntime
    ? parkAtIdle
      ? "idle"
      : (shell.activityRunStatus ?? shell.status)
    : null;
  const request = shell.pendingRuntimeRequest;
  if (request !== null && request.kind !== "user_input" && request.kind !== "auth_refresh") {
    return {
      state: "approval",
      since: DateTime.formatIso(request.createdAt),
      summary: clip(`Wartet auf Freigabe (${request.kind})`),
    };
  }
  if (request?.kind === "user_input") {
    const working =
      runStatus === "preparing" || runStatus === "starting" || runStatus === "running";
    if (request.blocking !== false || !working) {
      return {
        state: "input",
        since: DateTime.formatIso(request.createdAt),
        summary: "Wartet auf Eingabe",
      };
    }
  }
  if (runStatus === "failed") {
    const errorClass = shell.lastErrorClass ?? null;
    return {
      state: "error",
      since: DateTime.formatIso(shell.latestRunCompletedAt ?? shell.updatedAt),
      summary: clip(
        errorClass === null
          ? "Letzter Lauf fehlgeschlagen"
          : `Letzter Lauf fehlgeschlagen (${errorClass})`,
      ),
    };
  }
  return null;
}

function clip(text: string): string {
  return text.length > SUMMARY_MAX ? text.slice(0, SUMMARY_MAX) : text;
}

/** Waiting ticket threads, sorted by ticket. Threads without a ticket never appear. */
export function collectWaitingThreads(
  ticketThreads: Readonly<Record<string, { readonly threadId: string }>>,
  shells: ReadonlyArray<WaitingShellInput & { readonly id: string }>,
): WaitingThread[] {
  const ticketByThread = new Map<string, number>();
  for (const [ticketId, record] of Object.entries(ticketThreads)) {
    ticketByThread.set(record.threadId, Number(ticketId));
  }
  const waiting: WaitingThread[] = [];
  for (const shell of shells) {
    const ticket = ticketByThread.get(shell.id);
    if (ticket === undefined) continue;
    const derived = deriveWaitingState(shell);
    if (derived === null) continue;
    waiting.push({ ticket, threadId: shell.id, ...derived });
  }
  return waiting.toSorted((a, b) => a.ticket - b.ticket);
}

export function renderWaitingFile(threads: ReadonlyArray<WaitingThread>, now: Date): string {
  const file: WaitingFile = { version: 1, written_at: now.toISOString(), threads };
  return `${JSON.stringify(file)}\n`;
}

/** Atomic write (temp file + rename), mode 0600. */
export function writeWaitingFile(file: string, content: string): void {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(tmp, content, { mode: 0o600 });
  NodeFS.renameSync(tmp, file);
}

/** The slice of the orchestrator this file needs. */
export interface WaitingFileSource {
  readonly getShellSnapshot: (options: {
    readonly location: "active";
    readonly threadIds: ReadonlyArray<ThreadId>;
  }) => Effect.Effect<{ readonly threads: ReadonlyArray<OrchestrationV2ThreadShell> }, unknown>;
  readonly streamDomainEvents: Stream.Stream<unknown, unknown>;
}

/**
 * Writes once at start, then after a state change, at most every 10 s. Every failure is a warning;
 * a turn is never touched.
 */
export const startWaitingFile = (input: {
  readonly baseDir: string;
  readonly source: WaitingFileSource;
  readonly env?: NodeJS.ProcessEnv;
  readonly minIntervalMs?: number;
  readonly heartbeatMs?: number;
}) =>
  Effect.suspend(() => {
    if (!waitingFileEnabled(input.env)) return Effect.void;
    const file = waitingFilePath(input.baseDir);
    const minInterval = input.minIntervalMs ?? WAITING_MIN_INTERVAL_MS;
    const heartbeat = input.heartbeatMs ?? WAITING_HEARTBEAT_MS;
    let lastKey: string | null = null;
    let lastWriteMs = Number.NEGATIVE_INFINITY;

    // Writes when the content (without written_at) changed, or when the last write is a heartbeat old.
    const refresh = Effect.gen(function* () {
      const ticketThreads = readTicketThreadMap(ticketThreadFile(input.baseDir));
      const threadIds = Object.values(ticketThreads).map((record) => record.threadId);
      const snapshot =
        threadIds.length === 0
          ? { threads: [] }
          : // @effect-diagnostics-next-line anyUnknownInErrorContext:off - WaitingFileSource mirrors the orchestrator's untyped error channel; refresh() catches every cause
            yield* input.source.getShellSnapshot({
              location: "active",
              threadIds: threadIds as ThreadId[],
            });
      const waiting = collectWaitingThreads(ticketThreads, snapshot.threads);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - change-detection key of a plain object; never decoded
      const key = JSON.stringify(waiting);
      const nowMs = yield* Clock.currentTimeMillis;
      if (key === lastKey && nowMs - lastWriteMs < heartbeat) return;
      // @effect-diagnostics-next-line globalDateInEffect:off - Date built from Clock.currentTimeMillis, renderWaitingFile takes a Date
      writeWaitingFile(file, renderWaitingFile(waiting, new Date(nowMs)));
      lastKey = key;
      lastWriteMs = nowMs;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("flightplan waiting file not written", { cause: Cause.pretty(cause) }),
      ),
    );

    return Effect.gen(function* () {
      const signals = yield* Queue.dropping<void>(1);
      // The heartbeat re-reads the state itself; the event stream only makes it faster.
      yield* forkParked(
        Effect.gen(function* () {
          yield* refresh;
          while (true) {
            const fromEvent = yield* Effect.race(
              Queue.take(signals).pipe(Effect.as(true)),
              Effect.sleep(heartbeat).pipe(Effect.as(false)),
            );
            if (fromEvent) yield* Effect.sleep(minInterval);
            yield* refresh;
          }
        }),
      );
      yield* forkParked(
        Effect.suspend(() =>
          // @effect-diagnostics-next-line anyUnknownInErrorContext:off - WaitingFileSource mirrors the orchestrator's untyped error channel; caught by catchCause below
          Stream.runForEach(input.source.streamDomainEvents, () => Queue.offer(signals, undefined)),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("flightplan waiting file stopped watching", {
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("flightplan waiting file not started", { cause: Cause.pretty(cause) }),
      ),
    );
  });
