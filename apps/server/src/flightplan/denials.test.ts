import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { denialsFile, readDenialSummary, summarizeDenials } from "./denials.ts";

// Flightplan OP#1890
const row = (ticket: string | null, threadId: string, category: string, isProtected = false) =>
  JSON.stringify({
    at: "2026-11-11T20:00:00.000Z",
    threadId,
    ticket,
    tool: "Bash",
    category,
    protected: isProtected,
  });

describe("denial summary per ticket", () => {
  it("counts per ticket, flags protection and tracks the busiest thread", () => {
    const text = [
      row("1890", "a", "sudo"),
      row("1890", "a", "docker", true),
      row("1890", "b", "systemctl"),
      row("1890", "a", "rm-ausserhalb"),
      row("77", "c", "sudo"),
      row(null, "d", "sudo"),
      "kein json",
      "",
    ].join("\n");
    expect(summarizeDenials(text)).toEqual({
      "1890": { count: 4, protected: true, maxInThread: 3, lastCategory: "rm-ausserhalb" },
      "77": { count: 1, protected: false, maxInThread: 1, lastCategory: "sudo" },
    });
  });

  it("skips rows with an odd category and treats a missing file as empty", () => {
    expect(summarizeDenials(row("5", "a", "Bad Category!"))).toEqual({});
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fp-denials-sum-"));
    expect(readDenialSummary(denialsFile(dir))).toEqual({});
    NodeFS.mkdirSync(NodePath.join(dir, "userdata"));
    NodeFS.writeFileSync(denialsFile(dir), `${row("9", "a", "sudo")}\n`);
    expect(readDenialSummary(denialsFile(dir))).toEqual({
      "9": { count: 1, protected: false, maxInThread: 1, lastCategory: "sudo" },
    });
  });
});
