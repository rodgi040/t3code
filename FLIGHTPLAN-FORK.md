# Flightplan fork of T3 Code

Branch `flightplan/main`, based on the upstream tag `v0.1.6`. Upstream is MIT licensed
(`LICENSE` is unchanged). Changes against upstream:

1. Path prefix: `T3CODE_WEB_BASE_PATH=/chat pnpm --filter @t3tools/web build` builds the web app for a
   reverse proxy that strips `/chat` (`apps/web/src/basePath.ts`, Vite `base`, router `basepath`).
2. Framing: every response carries `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy:
   frame-ancestors 'self'` unless the response already sets one (`apps/server/src/http.ts`).
3. A2A provider: `integrations/flightplan-a2a/` plus `seedFlightplanA2aInstance` in
   `apps/server/src/provider/ProviderInstanceRegistryHydration.ts`.

Update: merge a new upstream tag into `flightplan/main`. Details in the Factory repo,
`openproject/chat/README.md`.
