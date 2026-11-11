import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { DENIALS_FILE_NAME, type DenialRecord } from "./denylist.ts";

/**
 * Flightplan OP#1890: reads `flightplan-denials.jsonl` and sums it up per ticket for `GET /api/flightplan/denials`
 * and the `denials` field of `fp:activity`.
 *
 * Limit that belongs here: while `t3-fp` runs as root, an agent can change or delete this file. The numbers are
 * a hint for the human, not a security proof (OP#1845).
 */
export interface TicketDenialSummary {
  /** Number of denials logged for the ticket. */
  readonly count: number;
  /** True when at least one denial hit a protection target (token path, main/master, Docker). */
  readonly protected: boolean;
  /** Most denials of one thread; three or more make the dashboard ask for attention. */
  readonly maxInThread: number;
  /** Category of the newest denial, never the command. */
  readonly lastCategory: string;
}

export type DenialSummary = Record<string, TicketDenialSummary>;

const MAX_LINES = 20_000;
const CATEGORY_PATTERN = /^[a-z0-9-]{1,40}$/;

export function denialsFile(baseDir: string): string {
  return NodePath.join(baseDir, "userdata", DENIALS_FILE_NAME);
}

function parseLine(line: string): DenialRecord | null {
  try {
    const row = JSON.parse(line) as Partial<Record<keyof DenialRecord, unknown>>;
    if (row === null || typeof row !== "object") return null;
    if (typeof row.ticket !== "string" || !/^\d+$/.test(row.ticket)) return null;
    if (typeof row.threadId !== "string" || typeof row.at !== "string") return null;
    if (typeof row.category !== "string" || !CATEGORY_PATTERN.test(row.category)) return null;
    return {
      at: row.at,
      threadId: row.threadId,
      ticket: row.ticket,
      tool: typeof row.tool === "string" ? row.tool : "",
      category: row.category as DenialRecord["category"],
      protected: row.protected === true,
    };
  } catch {
    return null;
  }
}

/** Sums the lines of the log per ticket. Broken lines and lines without a ticket are skipped. */
export function summarizeDenials(text: string): DenialSummary {
  const perThread = new Map<string, number>();
  const result: Record<
    string,
    { count: number; protected: boolean; maxInThread: number; lastCategory: string }
  > = {};
  const lines = text.split("\n").slice(-MAX_LINES);
  for (const line of lines) {
    if (line.length === 0) continue;
    const row = parseLine(line);
    if (row === null || row.ticket === null) continue;
    const key = `${row.ticket}\u0000${row.threadId}`;
    const inThread = (perThread.get(key) ?? 0) + 1;
    perThread.set(key, inThread);
    const known = result[row.ticket] ?? {
      count: 0,
      protected: false,
      maxInThread: 0,
      lastCategory: row.category,
    };
    result[row.ticket] = {
      count: known.count + 1,
      protected: known.protected || row.protected,
      maxInThread: Math.max(known.maxInThread, inThread),
      lastCategory: row.category,
    };
  }
  return result;
}

/** A missing or unreadable file is a normal state: no denials. */
export function readDenialSummary(file: string): DenialSummary {
  try {
    return summarizeDenials(NodeFS.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
