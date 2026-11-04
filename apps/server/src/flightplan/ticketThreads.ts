import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface TicketThreadRecord {
  readonly threadId: string;
  readonly environmentId: string;
  readonly projectId: string;
}

export type TicketThreadMap = Record<string, TicketThreadRecord>;

export function ticketIdFromPath(pathname: string): string | null {
  const match = pathname.match(/\/api\/flightplan\/tickets\/(\d+)\/?$/);
  return match?.[1] ?? null;
}

export function claimTicketThread(
  map: TicketThreadMap,
  ticketId: string,
  draft: TicketThreadRecord,
): { map: TicketThreadMap; record: TicketThreadRecord; created: boolean } {
  const existing = map[ticketId];
  if (existing?.threadId) return { map, record: existing, created: false };
  return {
    map: { ...map, [ticketId]: draft },
    record: draft,
    created: true,
  };
}

export function readTicketThreadMap(file: string): TicketThreadMap {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(file, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: TicketThreadMap = {};
    for (const [ticketId, value] of Object.entries(parsed)) {
      if (!/^\d+$/.test(ticketId) || value === null || typeof value !== "object") continue;
      const row = value as Partial<TicketThreadRecord>;
      if (!row.threadId || !row.environmentId || !row.projectId) continue;
      map[ticketId] = {
        threadId: String(row.threadId),
        environmentId: String(row.environmentId),
        projectId: String(row.projectId),
      };
    }
    return map;
  } catch {
    return {};
  }
}

export function writeTicketThreadMap(file: string, map: TicketThreadMap): void {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(tmp, `${JSON.stringify(map)}\n`, { mode: 0o600 });
  NodeFS.renameSync(tmp, file);
}

export function ticketThreadFile(baseDir: string): string {
  return NodePath.join(baseDir, "userdata", "flightplan-ticket-threads.json");
}
