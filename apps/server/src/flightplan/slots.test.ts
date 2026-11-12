// @effect-diagnostics nodeBuiltinImport:off - plain synchronous Node file code outside the Effect runtime (Flightplan module).
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it as effectIt } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { checkTicketSlot, evaluateSlots, slotLimit, slotRefusalMessage } from "./slots.ts";

const T0 = DateTime.makeUnsafe("2026-11-11T10:00:00Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FOUR_BUSY = { 0: "running", 1: "running", 2: "running", 3: "running" };

function setup(statuses: Record<number, string>) {
  const tickets = [101, 102, 103, 104, 105, 106];
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fp-slots-"));
  const file = NodePath.join(dir, "map.json");
  const map = Object.fromEntries(
    tickets.map((t, i) => [String(t), { threadId: uuid(i), environmentId: "env", projectId: "p" }]),
  );
  NodeFS.writeFileSync(file, JSON.stringify(map));
  const store = {
    listActiveShellIndex: () =>
      Effect.succeed(tickets.map((_, i) => ({ id: uuid(i), mayBeLive: true }))),
    getThreadShell: (id: string) =>
      Effect.succeed({
        activityRunStatus: statuses[Number(id.slice(-12))] ?? null,
        latestRunRequestedAt: T0,
      }),
  } as never;
  return { file, store };
}

const run = (
  threadIndex: number,
  statuses: Record<number, string>,
  extra: { env?: Record<string, string>; other?: string[] } = {},
) => {
  const { file, store } = setup(statuses);
  return checkTicketSlot({
    mapFile: () => file,
    threadId: uuid(threadIndex),
    requestedAt: DateTime.add(T0, { seconds: 1 }),
    otherRunStatuses: extra.other ?? [],
    store,
    env: extra.env ?? {},
  });
};

describe("slots (pure)", () => {
  it("parses the limit", () => {
    expect(slotLimit({})).toBe(4);
    expect(slotLimit({ T3CODE_FP_SLOT_LIMIT: "2" })).toBe(2);
    expect(slotLimit({ T3CODE_FP_SLOT_LIMIT: "0" })).toBe(0);
    expect(slotLimit({ T3CODE_FP_SLOT_LIMIT: "x" })).toBe(4);
  });

  it("names the busy tickets in German", () => {
    expect(slotRefusalMessage(["1", "2", "3", "4"])).toBe(
      "Vier Ticket-Threads arbeiten bereits (#1, #2, #3, #4). Dieser Turn wurde nicht gestartet. Bitte sende ihn erneut, sobald ein Platz frei ist.",
    );
  });

  it("uses singular for one thread", () => {
    expect(slotRefusalMessage(["7"])).toBe(
      "Ein Ticket-Thread arbeitet bereits (#7). Dieser Turn wurde nicht gestartet. Bitte sende ihn erneut, sobald ein Platz frei ist.",
    );
  });

  it("lets only the earlier of two simultaneous starts win", () => {
    const starting = (ticket: string, threadId: string, requestedAtMs: number) => ({
      ticket,
      threadId,
      status: "starting",
      requestedAtMs,
    });
    const running = [1, 2, 3].map((n) => ({
      ticket: String(n),
      threadId: `r${n}`,
      status: "running",
      requestedAtMs: 0,
    }));
    const a = starting("10", "a", 100);
    const b = starting("11", "b", 200);
    expect(evaluateSlots({ limit: 4, self: a, candidates: [...running, b] }).allowed).toBe(true);
    expect(evaluateSlots({ limit: 4, self: b, candidates: [...running, a] }).allowed).toBe(false);
  });
});

describe("checkTicketSlot", () => {
  effectIt.effect("refuses the fifth start", () =>
    Effect.gen(function* () {
      const d = yield* run(4, { ...FOUR_BUSY, 4: "starting" });
      expect(d).toMatchObject({ allowed: false, tickets: ["101", "102", "103", "104"] });
    }),
  );

  effectIt.effect("allows the fourth start", () =>
    Effect.gen(function* () {
      expect(yield* run(3, { 0: "running", 1: "running", 2: "running", 3: "starting" })).toEqual({
        allowed: true,
      });
    }),
  );

  effectIt.effect("does not count waiting threads", () =>
    Effect.gen(function* () {
      const d = yield* run(4, {
        0: "running",
        1: "running",
        2: "waiting",
        3: "waiting",
        4: "starting",
      });
      expect(d.allowed).toBe(true);
    }),
  );

  effectIt.effect("leaves a free chat alone", () =>
    Effect.gen(function* () {
      const { file, store } = setup(FOUR_BUSY);
      const d = yield* checkTicketSlot({
        mapFile: () => file,
        threadId: uuid(99),
        requestedAt: T0,
        otherRunStatuses: [],
        store,
        env: {},
      });
      expect(d.allowed).toBe(true);
    }),
  );

  effectIt.effect("leaves the continuation of a working thread alone", () =>
    Effect.gen(function* () {
      const d = yield* run(4, { ...FOUR_BUSY, 4: "starting" }, { other: ["running"] });
      expect(d.allowed).toBe(true);
    }),
  );

  effectIt.effect("is off with T3CODE_FP_SLOT_LIMIT=0 and follows another number", () =>
    Effect.gen(function* () {
      const busy = { ...FOUR_BUSY, 4: "starting" };
      expect((yield* run(4, busy, { env: { T3CODE_FP_SLOT_LIMIT: "0" } })).allowed).toBe(true);
      expect((yield* run(4, busy, { env: { T3CODE_FP_SLOT_LIMIT: "6" } })).allowed).toBe(true);
      expect((yield* run(4, busy, { env: { T3CODE_FP_SLOT_LIMIT: "2" } })).allowed).toBe(false);
    }),
  );

  effectIt.effect("fails open when the store or the map cannot be read", () =>
    Effect.gen(function* () {
      const { file } = setup({});
      const broken = {
        listActiveShellIndex: () => Effect.die("boom"),
        getThreadShell: () => Effect.die("boom"),
      } as never;
      const base = {
        threadId: uuid(0),
        requestedAt: T0,
        otherRunStatuses: [],
        store: broken,
        env: {},
      };
      expect((yield* checkTicketSlot({ ...base, mapFile: () => file })).allowed).toBe(true);
      const noBaseDir = yield* checkTicketSlot({
        ...base,
        mapFile: () => {
          throw new Error("no base dir");
        },
      });
      expect(noBaseDir.allowed).toBe(true);
    }),
  );
});
