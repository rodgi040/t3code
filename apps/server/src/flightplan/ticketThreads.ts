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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Shape check for a PUT body: UUID thread id, short plain-token environment and project ids. */
export function parseTicketThreadDraft(value: unknown): TicketThreadRecord | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const { threadId, environmentId, projectId } = row;
  if (typeof threadId !== "string" || !UUID_PATTERN.test(threadId)) return null;
  if (typeof environmentId !== "string" || !ID_PATTERN.test(environmentId)) return null;
  if (typeof projectId !== "string" || !ID_PATTERN.test(projectId)) return null;
  return { threadId, environmentId, projectId };
}
