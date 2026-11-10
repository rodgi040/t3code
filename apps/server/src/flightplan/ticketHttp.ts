import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { flightplanConfig, isTicketRequestAllowed } from "../flightplanConfig.ts";
import { authenticateRawRouteWithScope } from "../http.ts";
import {
  claimTicketThread,
  readTicketThreadMap,
  parseTicketThreadDraft,
  parseTicketThreadReplaces,
  ticketIdFromPath,
  ticketThreadFile,
  writeTicketThreadMap,
} from "./ticketThreads.ts";

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

const handle = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig.ServerConfig;
  const fp = yield* flightplanConfig;
  // PUT: allowed Origin mandatory. GET: Origin optional (same-origin fetch), but if set it must be allowed.
  if (
    !isTicketRequestAllowed({
      method: request.method,
      secFetchSite: request.headers["sec-fetch-site"],
      origin: request.headers.origin,
      host: request.headers.host,
      allowedOrigins: fp.allowedOrigins,
    })
  ) {
    return HttpServerResponse.text("Forbidden", { status: 403 });
  }
  // Session cookie required: read scope for GET, operate scope for PUT.
  yield* authenticateRawRouteWithScope(
    request.method === "PUT" ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
  );
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const ticketId = ticketIdFromPath(url.value.pathname);
  if (!ticketId) return HttpServerResponse.text("Not Found", { status: 404 });
  const file = ticketThreadFile(config.baseDir);

  if (request.method === "GET") {
    const record = yield* Effect.promise(() => locked(() => readTicketThreadMap(file)[ticketId]));
    // A ticket without a thread yet is a normal state (first click): 200 with null instead of a console-filling 404.
    return json(record ?? null);
  }
  if (request.method !== "PUT") {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }
  const parsed = yield* request.json.pipe(Effect.orElseSucceed(() => null));
  const draft = parseTicketThreadDraft(parsed);
  if (!draft) return HttpServerResponse.text("Bad Request", { status: 400 });
  const claimed = yield* Effect.promise(() =>
    locked(() => {
      const result = claimTicketThread(
        readTicketThreadMap(file),
        ticketId,
        draft,
        parseTicketThreadReplaces(parsed),
      );
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
