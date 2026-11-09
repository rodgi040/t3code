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
7. Embed layout and ticket start (OP#1719, OP#1705, OP#1720): in the embed the composer area (agent chips, ticket
   chip, usage line, questions) sits in the normal flow under the timeline instead of an absolute overlay, and the
   empty state aligns to the top and scrolls on low height (`ChatView.tsx`, `FlightplanComposer.tsx`). A ticket
   start names the thread `#<id> <Titel>` (`ticketThreadTitle` in `useComposerSend.ts`), the title regeneration
   skips messages with a `<ticket-context>` block (`ThreadTitleRegenerationService.ts`), and the message row shows a
   compact ticket line instead of the block (`ticketContextForDisplay` in `channel.ts`, `TimelineUserMessageRow.tsx`).
   The agent still receives the block unchanged.
8. Answer confirmation (Flightplan OP#1710): after `fp:answer` the parent replies with
   `{type:"fp:answered", questionId, ok, status, answer, error}` (accepted only from `http://localhost:8090`). The chat
   keeps the answered question visible as "Beantwortet: <Antwort> · Status jetzt <Status>", disables the button while
   sending ("Wird gesendet …") and shows a parent error as `role="alert"` (`sendAnswer`, `applyAnswered` in `channel.ts`,
   `FlightplanComposer.tsx`). The OpenProject module sends `fp:answered` to the iframe origin `http://localhost:8092`.
9. Hermes logo (Flightplan OP#1703): the A2A instance `flightplanA2a` ("Gandalf") shows the Hermes agent logo
   (round, white backdrop, `apps/web/src/flightplan/hermes-agent.png`, 96 px) instead of the default provider symbol.
   `HermesAvatar.tsx` renders it; `ProviderInstanceIcon` takes an optional `instanceId` and swaps the icon, passed from
   the model picker, model list, picker sidebar, sidebar thread rows and the embed target chip (`FlightplanComposer.tsx`).
   Other instances keep their icon. The PNG is imported, so Vite applies the `/chat` base path.

Update: merge a new upstream tag into `flightplan/main`. Details in the Factory repo,
`openproject/chat/README.md`.
