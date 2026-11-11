import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  collectWaitingThreads,
  deriveWaitingState,
  renderWaitingFile,
  waitingFileEnabled,
  waitingFilePath,
  writeWaitingFile,
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
