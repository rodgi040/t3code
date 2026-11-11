import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { AuthOrchestrationReadScope } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { flightplanConfig, isTicketRequestAllowed } from "../flightplanConfig.ts";
import { authenticateRawRouteWithScope } from "../http.ts";
import { denialsFile, readDenialSummary } from "./denials.ts";

// Flightplan OP#1890: read-only. `{ "<ticket>": { count, protected, maxInThread, lastCategory } }`.
const handle = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig.ServerConfig;
  const fp = yield* flightplanConfig;
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
  yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
  const summary = readDenialSummary(denialsFile(config.baseDir));
  return HttpServerResponse.text(JSON.stringify(summary), {
    status: 200,
    contentType: "application/json",
  });
});

export const layer = HttpRouter.add("GET", "/api/flightplan/denials", handle);
