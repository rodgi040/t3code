// @effect-diagnostics nodeBuiltinImport:off - plain synchronous Node file code outside the Effect runtime (Flightplan module).
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it as effectIt } from "@effect/vitest";
import { DateTime, Effect, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";

import {
  collectWaitingThreads,
  deriveWaitingState,
  renderWaitingFile,
  waitingFileEnabled,
  startWaitingFile,
  waitingFilePath,
  writeWaitingFile,
  type WaitingFileSource,
  type WaitingShellInput,
} from "./waitingFile.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function shell(over: Partial<WaitingShellInput> = {}): WaitingShellInput & { id: string } {
  return {
    id: "thread-1",
    status: "running",
    activityRunStatus: undefined,
    activeProviderThreadId: null,
    latestRunId: "run-1",
    latestRunCompletedAt: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    lastErrorClass: null,
    updatedAt: at("2026-11-11T10:00:00Z"),
    ...over,
  } as WaitingShellInput & { id: string };
}

const request = (kind: string, blocking?: boolean) =>
  ({
    id: "req",
    kind,
    createdAt: at("2026-11-11T10:05:00Z"),
    ...(blocking === undefined ? {} : { blocking }),
  }) as never;

describe("flightplan waiting file", () => {
  it("derives approval, input and error like the web client", () => {
    expect(deriveWaitingState(shell())).toBeNull();
    expect(
      deriveWaitingState(shell({ pendingRuntimeRequest: request("command_execution") })),
    ).toMatchObject({ state: "approval", since: "2026-11-11T10:05:00.000Z" });
    expect(deriveWaitingState(shell({ pendingRuntimeRequest: request("user_input") }))?.state).toBe(
      "input",
    );
    expect(
      deriveWaitingState(shell({ pendingRuntimeRequest: request("auth_refresh") })),
    ).toBeNull();
    // an async question does not wait while its run is still working
    expect(
      deriveWaitingState(shell({ pendingRuntimeRequest: request("user_input", false) })),
    ).toBeNull();
    expect(
      deriveWaitingState(
        shell({ status: "idle", pendingRuntimeRequest: request("user_input", false) }),
      )?.state,
    ).toBe("input");
    expect(
      deriveWaitingState(
        shell({
          status: "failed",
          lastErrorClass: "usage_limit",
          latestRunCompletedAt: at("2026-11-11T09:00:00Z"),
        }),
      ),
    ).toMatchObject({
      state: "error",
      since: "2026-11-11T09:00:00.000Z",
      summary: "Letzter Lauf fehlgeschlagen (usage_limit)",
    });
    expect(
      deriveWaitingState(shell({ status: "failed", activityRunStatus: "running" })),
    ).toBeNull();
  });

  it("lists only ticket threads, sorted, without free text", () => {
    const threads = collectWaitingThreads({ "20": { threadId: "b" }, "7": { threadId: "a" } }, [
      shell({ pendingRuntimeRequest: request("command_execution") }),
      { ...shell({ status: "failed" }), id: "a" },
      { ...shell({ status: "failed" }), id: "b" },
    ]);
    expect(threads.map((t) => [t.ticket, t.threadId, t.state])).toEqual([
      [7, "a", "error"],
      [20, "b", "error"],
    ]);
    for (const t of threads) expect(t.summary.length).toBeLessThanOrEqual(200);
  });

  it("writes the exact format atomically with mode 0600", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fp-waiting-"));
    const file = waitingFilePath(dir);
    expect(file).toBe(NodePath.join(dir, "userdata", "flightplan-waiting.json"));
    const rows = [
      {
        ticket: 7,
        threadId: "a",
        state: "approval" as const,
        since: "2026-11-11T10:05:00.000Z",
        summary: "Wartet auf Freigabe (command_execution)",
      },
    ];
    // @effect-diagnostics-next-line globalDate:off - test fixture timestamp
    writeWaitingFile(file, renderWaitingFile(rows, new Date("2026-11-11T10:06:00Z")));
    expect(JSON.parse(NodeFS.readFileSync(file, "utf8"))).toEqual({
      version: 1,
      written_at: "2026-11-11T10:06:00.000Z",
      threads: rows,
    });
    expect(NodeFS.statSync(file).mode & 0o777).toBe(0o600);
    expect(NodeFS.readdirSync(NodePath.dirname(file))).toEqual(["flightplan-waiting.json"]);
    NodeFS.rmSync(dir, { recursive: true });
  });

  it("is on unless T3CODE_FP_WAITING_FILE is 0", () => {
    expect(waitingFileEnabled({})).toBe(true);
    expect(waitingFileEnabled({ T3CODE_FP_WAITING_FILE: "0" })).toBe(false);
    expect(waitingFileEnabled({ T3CODE_FP_WAITING_FILE: "1" })).toBe(true);
  });
});

describe("flightplan waiting file loop", () => {
  const tmpBase = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fp-waiting-loop-"));
  const mapTicket = (base: string) => {
    NodeFS.mkdirSync(NodePath.join(base, "userdata"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(base, "userdata", "flightplan-ticket-threads.json"),
      JSON.stringify({ "7": { threadId: "thread-1", environmentId: "e", projectId: "p" } }),
    );
  };
  const readFile = (base: string) =>
    JSON.parse(NodeFS.readFileSync(waitingFilePath(base), "utf8")) as {
      written_at: string;
      threads: Array<{ since: string }>;
    };
  const makeSource = (state: { shells: unknown[] }, events: Stream.Stream<unknown, unknown>) =>
    ({
      getShellSnapshot: () => Effect.sync(() => ({ threads: state.shells })),
      streamDomainEvents: events,
    }) as unknown as WaitingFileSource;
  const approval = [shell({ pendingRuntimeRequest: request("command_execution") })].map((row) => ({
    ...row,
    id: "thread-1",
  }));

  effectIt.effect("heartbeat renews written_at and keeps threads and since", () =>
    Effect.gen(function* () {
      const base = tmpBase();
      mapTicket(base);
      yield* startWaitingFile({
        baseDir: base,
        source: makeSource({ shells: approval }, Stream.never),
        env: {},
      });
      yield* Effect.yieldNow;
      const first = readFile(base);
      yield* TestClock.adjust("59 seconds");
      expect(readFile(base).written_at).toBe(first.written_at);
      yield* TestClock.adjust("2 seconds");
      const second = readFile(base);
      expect(second.written_at).not.toBe(first.written_at);
      expect(second.threads).toEqual(first.threads);
      expect(second.threads).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("throttle delays an event by 10 s but does not lose it", () =>
    Effect.gen(function* () {
      const base = tmpBase();
      mapTicket(base);
      const state = { shells: [] as unknown[] };
      const events = yield* Queue.unbounded<number>();
      yield* startWaitingFile({
        baseDir: base,
        source: makeSource(state, Stream.fromQueue(events)),
        env: {},
      });
      yield* Effect.yieldNow;
      expect(readFile(base).threads).toEqual([]);
      state.shells = approval;
      yield* Queue.offer(events, 1);
      yield* TestClock.adjust("9 seconds");
      expect(readFile(base).threads).toEqual([]);
      yield* TestClock.adjust("1 seconds");
      expect(readFile(base).threads).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("creates a missing folder, survives a write failure and retries", () =>
    Effect.gen(function* () {
      const base = tmpBase();
      const file = waitingFilePath(base);
      NodeFS.mkdirSync(file, { recursive: true });
      yield* startWaitingFile({
        baseDir: base,
        source: makeSource({ shells: [] }, Stream.never),
        env: {},
      });
      yield* Effect.yieldNow;
      expect(NodeFS.statSync(file).isDirectory()).toBe(true);
      NodeFS.rmSync(file, { recursive: true });
      yield* TestClock.adjust("61 seconds");
      expect(readFile(base).threads).toEqual([]);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("a failing event stream does not stop the heartbeat", () =>
    Effect.gen(function* () {
      const base = tmpBase();
      yield* startWaitingFile({
        baseDir: base,
        source: makeSource({ shells: [] }, Stream.fail("boom")),
        env: {},
      });
      yield* Effect.yieldNow;
      const first = readFile(base).written_at;
      yield* TestClock.adjust("61 seconds");
      expect(readFile(base).written_at).not.toBe(first);
    }).pipe(Effect.scoped),
  );
});
