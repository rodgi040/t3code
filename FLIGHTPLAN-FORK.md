# Flightplan fork of T3 Code

Branch `flightplan/main`, based on the upstream tag `v0.1.6`. Upstream is MIT licensed
(`LICENSE` is unchanged). Changes against upstream:

1. Path prefix: `T3CODE_WEB_BASE_PATH=/chat pnpm --filter @t3tools/web build` builds the web app for a
   reverse proxy (`apps/web/src/basePath.ts`, Vite `base`, router `basepath`). The server accepts the
   prefix itself with `T3CODE_BASE_PATH=/chat` (`layerRequestGate` in `apps/server/src/http.ts`), so a
   proxy may keep or strip it.
2. Framing: every response carries `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy:
   frame-ancestors 'self'` unless the response already sets one (`apps/server/src/http.ts`).
3. A2A provider: `integrations/flightplan-a2a/` plus `seedFlightplanA2aInstance` in
   `apps/server/src/provider/ProviderInstanceRegistryHydration.ts`.
4. Parent channel: the web client accepts `fp:context` and `fp:questions` only from
   `http://localhost:8090` and answers with `fp:answer` to that origin (`apps/web/src/flightplan/`).
   `#123` in a prompt is expanded server-side with `fp-op get` as user `claude`. Claude Code turns
   open one Langfuse trace from the host sender file; the id is not a secret, the keys stay in that file.
5. AgentScope: `seedFlightplanAgentscopeInstance` is a second local ACP instance. Its environment
   `FP_A2A_AGENTS=agentscope` is passed through the ACP driver's instance environment. Fake model
   mode stays on the agent container.
6. Hardening: `T3CODE_ALLOWED_ORIGINS` (WebSocket origin check for cookie auth), session cookie `Path`/`Secure`,
   `T3CODE_DISABLE_SURFACES=guest,mcp,oauth` (404), `T3CODE_SUPPRESS_STARTUP_PAIRING=1`, pairing links with the base path
   (`apps/server/src/flightplanConfig.ts`). Web build: `VITE_T3CODE_BASE_PATH_EXCLUDE` keeps `/api/v3/` unprefixed.

Update: merge a new upstream tag into `flightplan/main`. Details in the Factory repo,
`openproject/chat/README.md`.
