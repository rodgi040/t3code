import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  claimTicketThread,
  readTicketThreadMap,
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
    const other = claimTicketThread(second.map, "12", {
      threadId: "thread-c",
      environmentId: "env",
      projectId: "project",
    });
    expect(other.record.threadId).toBe("thread-c");
    expect(other.map["11"]?.threadId).toBe("thread-a");
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
