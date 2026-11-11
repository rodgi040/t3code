// @effect-diagnostics nodeBuiltinImport:off - plain synchronous Node file code outside the Effect runtime (Flightplan module).
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  claimTicketThread,
  parseTicketThreadDraft,
  readTicketThreadMap,
  ticketForThread,
  ticketIdFromPath,
  ticketThreadFile,
  writeTicketThreadMap,
} from "./ticketThreads.ts";

describe("flightplan ticket threads", () => {
  it("reads the ticket id from the API path", () => {
    expect(ticketIdFromPath("/api/flightplan/tickets/1132")).toBe("1132");
    expect(ticketIdFromPath("/api/flightplan/tickets/nope")).toBeNull();
  });

  it("keeps the first thread for a ticket", () => {
    const first = claimTicketThread({}, "11", {
      threadId: "thread-a",
      environmentId: "env",
      projectId: "project",
    });
    expect(first.created).toBe(true);
    const second = claimTicketThread(first.map, "11", {
      threadId: "thread-b",
      environmentId: "env",
      projectId: "project",
    });
    expect(second.created).toBe(false);
    expect(second.record.threadId).toBe("thread-a");
    const stale = claimTicketThread(first.map, "11", second.record, "thread-x");
    expect(stale.record.threadId).toBe("thread-a");
    const replaced = claimTicketThread(
      first.map,
      "11",
      { threadId: "thread-b", environmentId: "env", projectId: "project" },
      "thread-a",
    );
    expect(replaced.created).toBe(true);
    expect(replaced.map["11"]?.threadId).toBe("thread-b");
    const other = claimTicketThread(second.map, "12", {
      threadId: "thread-c",
      environmentId: "env",
      projectId: "project",
    });
    expect(other.record.threadId).toBe("thread-c");
    expect(other.map["11"]?.threadId).toBe("thread-a");
  });

  // OP#1853
  it("finds the ticket of a thread", () => {
    const map = {
      "11": { threadId: "thread-a", environmentId: "env", projectId: "project" },
      "12": { threadId: "thread-b", environmentId: "env", projectId: "project" },
    };
    expect(ticketForThread(map, "thread-b")).toBe("12");
    expect(ticketForThread(map, "thread-x")).toBeUndefined();
    expect(ticketForThread({}, "thread-a")).toBeUndefined();
  });

  it("round-trips the map on disk", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fp-threads-"));
    const file = ticketThreadFile(dir);
    writeTicketThreadMap(file, {
      "11": { threadId: "thread-a", environmentId: "env", projectId: "project" },
    });
    expect(readTicketThreadMap(file)["11"]?.threadId).toBe("thread-a");
    const mode = NodeFS.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("flightplan ticket thread draft validation", () => {
  const ok = {
    threadId: "123e4567-e89b-42d3-a456-426614174000",
    environmentId: "env-1",
    projectId: "proj_1",
  };
  it("accepts a well-formed draft", () => {
    expect(parseTicketThreadDraft(ok)).toEqual(ok);
  });
  it("rejects bad thread ids and odd ids", () => {
    expect(parseTicketThreadDraft({ ...ok, threadId: "thread-a" })).toBeNull();
    expect(parseTicketThreadDraft({ ...ok, environmentId: "../x" })).toBeNull();
    expect(parseTicketThreadDraft({ ...ok, projectId: 5 })).toBeNull();
    expect(parseTicketThreadDraft(null)).toBeNull();
  });
});
