import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { denialsFile, readDenialSummary, resetDenialCache, summarizeDenials } from "./denials.ts";

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

describe("denial summary cache", () => {
  it("keeps the summary for 10 s while size and mtime are the same, then reads again", () => {
    resetDenialCache();
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fp-denials-cache-"));
    NodeFS.mkdirSync(NodePath.join(dir, "userdata"));
    const file = denialsFile(dir);
    NodeFS.writeFileSync(file, `${row("9", "a", "sudo")}\n`);
    const first = readDenialSummary(file, 1_000);
    expect(readDenialSummary(file, 5_000)).toBe(first);
    expect(readDenialSummary(file, 11_500)).not.toBe(first);
    expect(readDenialSummary(file, 11_500)["9"]?.count).toBe(1);
  });

  it("reads again at once when the file changed", () => {
    resetDenialCache();
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fp-denials-cache-"));
    NodeFS.mkdirSync(NodePath.join(dir, "userdata"));
    const file = denialsFile(dir);
    NodeFS.writeFileSync(file, `${row("9", "a", "sudo")}\n`);
    expect(readDenialSummary(file, 1_000)["9"]?.count).toBe(1);
    NodeFS.appendFileSync(file, `${row("9", "a", "docker", true)}\n`);
    expect(readDenialSummary(file, 2_000)["9"]?.count).toBe(2);
    NodeFS.rmSync(file);
    expect(readDenialSummary(file, 3_000)).toEqual({});
  });
});
