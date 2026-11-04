import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import {
  claimTicketThread,
  readTicketThreadMap,
  ticketIdFromPath,
  ticketThreadFile,
  writeTicketThreadMap,
  type TicketThreadRecord,
} from "./ticketThreads.ts";

const CHAT_ORIGIN = "http://localhost:8092";

let pending: Promise<void> = Promise.resolve();

function locked<T>(fn: () => T): Promise<T> {
  const run = pending.then(fn, fn);
  pending = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function json(body: unknown, status = 200) {
  return HttpServerResponse.text(JSON.stringify(body), {
    status,
    contentType: "application/json",
  });
}

function asRecord(value: unknown): TicketThreadRecord | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Partial<TicketThreadRecord>;
  if (!row.threadId || !row.environmentId || !row.projectId) return null;
  return {
    threadId: String(row.threadId),
    environmentId: String(row.environmentId),
    projectId: String(row.projectId),
  };
}

const handle = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig.ServerConfig;
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin.length > 0 && origin !== CHAT_ORIGIN) {
    return HttpServerResponse.text("Forbidden", { status: 403 });
  }
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const ticketId = ticketIdFromPath(url.value.pathname);
  if (!ticketId) return HttpServerResponse.text("Not Found", { status: 404 });
  const file = ticketThreadFile(config.baseDir);

  if (request.method === "GET") {
    const record = yield* Effect.promise(() => locked(() => readTicketThreadMap(file)[ticketId]));
    return record ? json(record) : HttpServerResponse.text("Not Found", { status: 404 });
  }
  if (request.method !== "PUT") {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  const parsed = yield* request.json.pipe(Effect.orElseSucceed(() => null));
  const draft = asRecord(parsed);
  if (!draft) return HttpServerResponse.text("Bad Request", { status: 400 });
  const claimed = yield* Effect.promise(() =>
    locked(() => {
      const result = claimTicketThread(readTicketThreadMap(file), ticketId, draft);
      if (result.created) writeTicketThreadMap(file, result.map);
      return result;
    }),
  );
  return json({ ...claimed.record, created: claimed.created });
});

export const layer = Layer.mergeAll(
  HttpRouter.add("GET", "/api/flightplan/tickets/*", handle),
  HttpRouter.add("PUT", "/api/flightplan/tickets/*", handle),
);
