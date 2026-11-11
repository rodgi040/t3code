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
10. Client tracing off in the embed (OP#1706): with `T3CODE_WEB_BASE_PATH` set, the web client does not start the OTLP
    exporter (`configureClientTracing` in `apps/web/src/observability/clientTracing.ts`), so the chat proxy no longer
    sees `POST /chat/api/observability/v1/traces` (403). `VITE_T3CODE_DISABLE_CLIENT_TRACING=1|0` forces it off or on at
    build time. The server's own tracing is untouched.
11. Full layout in the dashboard split (OP#1778): the switch is the query parameter `?layout=full` on the URL the parent
    frames (`/chat/?layout=full`, `/chat/embed/<id>?layout=full`). It is read once per page load before the router starts
    (`captureFrameLayout` in `apps/web/src/flightplan/embed.ts`, called from `installFlightplanChannel`), so in-app
    navigation keeps it. With it the frame shows T3 as standalone: thread sidebar, header, settings; `isEmbedLocation` is
    false and the embed route opens the ticket's thread without `?embed=1`. The sidebar turns into a sheet only below
    600 px frame width instead of 768 px (`sidebarMobileQuery`, `html[data-fp-frame="full"]` rules in `index.css`), so
    the thread list stays visible in a 1440 px window. Without the parameter (`/chat/embed/<id>` on the workplace page,
    `?embed=1`) the compact embed layout stays as before. The Flightplan parts (ticket chip, comment box, history,
    questions, start context) do not depend on the layout; in the full layout they belong only to the thread the parent
    opened for the ticket (`bindTicketThread`, `ticketForThread` in `channel.ts`), so another thread or a new chat shows
    nothing ticket-related. A query parameter was chosen over a parent message because it is known before the first
    render and needs no handshake; the proxy allowlist matches `$uri` without the query, so no proxy change is needed.
12. Thread report to the dashboard (OP#1778): in the full layout the chat posts `{type:"fp:thread", threadId,
    ticketId}` to `http://localhost:8090` whenever the open thread or its title changes (`reportThread` in
    `channel.ts`, called from `ChatView`). `ticketId` is the ticket the parent opened for that thread, else a ticket named
    in the title (`Ticket #<id>`, `#<id> <Titel>`), else `null`. The dashboard moves its "Im Chat" mark with it. Repeats are
    dropped; the compact embed and standalone pages send nothing.
13. Ticket bar in the dashboard split (OP#1784): in the full layout `FlightplanTicketBar` sits under `ChatHeader` with
    number, title, status, project, type, priority, labels, assignee and a link to OpenProject. It is collapsible, opens
    by itself when the ticket has an open question and keeps its state per ticket in `localStorage`. Questions, the
    cleaned ticket history and the comment box live in the bar; the compact embed keeps them in the composer.
    `fp:context` with `threadId` binds the ticket to exactly that thread. If the thread mapped to a ticket was deleted,
    the ticket route shows a hint and offers a new chat; the server replaces the mapping only when the request names the
    thread the client saw (`replaces` in `ticketThreads.ts`), otherwise the first thread wins.
14. Session context once (OP#1803): `enrichFlightplanPrompt` in `apps/server/src/flightplan/prompt.ts` adds the fp-op hint
    and the `Trace:` line only to the first turn of a thread (`firstTurn` from `ProviderTurnStartService`). Slash
    commands (`/goal clear`, `/compact`, ...) reach the provider verbatim on every turn, and a `[[fp-trace:...]]` marker
    is always stripped; `parseGoalCommand` ignores a marker from an older web build. The Langfuse trace is still created
    per turn and carries the thread id as `sessionId`. Unchanged by design: a message that names `#<id>` gets that
    ticket's `fp-op get` output appended (up to 8 KB) on every turn.
15. Agent activity per ticket (OP#1802): `FlightplanActivity` (rendered from `AppSidebarLayout`, full layout only) posts
    `{type:"fp:activity"}` with the tickets whose thread has a turn in flight to `http://localhost:8090`, on change and
    every 30 s. A turn that waits for an approval or an answer does not count. The dashboard shows "Agent arbeitet" in
    the ticket picker from it; the signal is transient and writes nothing to OpenProject. Concept:
    Factory `Flightplan V1.0/_meta/planning/KONZEPT-OP1802-TICKET-ZUSTAND-20261110.md`.
16. Start turn on the first open of a ticket (OP#1802): when the dashboard frame creates the thread for a ticket,
    `_chat.embed.$ticketId.tsx` sends one start turn (state summary, open decisions, questions, change nothing).
    Reopening the ticket, the compact workplace embed and a lost claim race send nothing. The ticket block goes out
    while the thread has no user message yet (`useComposerSend.ts`).

Update: merge a new upstream tag into `flightplan/main`. Details in the Factory repo,
`openproject/chat/README.md`.
