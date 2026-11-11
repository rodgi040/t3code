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
14a. Assumption rule in the start prompt (OP#1838): with the same first-turn context, `assumptionRule(ticket)` adds a German
    block: decide inside the approved plan and scope yourself, record a decision the human might see differently with
    `fp-op assume <ticket> --text "..."` (one open assumption at most, Exit 2 means ask instead), work only in the own
    branch and do not merge while one is open, always ask about the reserved topics (deploy, host, secrets, deleting,
    money, customers, scope, architecture, reviewer findings, skipping a gate), finish with `fp-op result <ticket>
    --stdin`. The rule is off unless `T3CODE_FP_ASSUMPTION_RULE=1`; without it the prompt is exactly as before. The ticket number
    comes only from the fixed start of the turn (the `<ticket-context>` block's `Ticket #N` line or a start turn
    `Ticket #N wurde im ADA-Dashboard geöffnet.`), never from a `#<id>` elsewhere; otherwise no rule. Autostart is unchanged.
    OP#1842 adds one line to the rule: ask with `fp-op ask <ticket> --question ... --option ... --recommend <option>
    --kind entscheidung|freigabe|zugang|abnahme` and `--reversible` or `--irreversible` (same switch, server restart needed).
15. Agent activity per ticket (OP#1802): `FlightplanActivity` (rendered from `AppSidebarLayout`, full layout only) posts
    `{type:"fp:activity"}` with the tickets whose thread has a turn in flight to `http://localhost:8090`, on change and
    every 30 s. A turn that waits for an approval or an answer does not count in `tickets`. Since OP#1834 the message is
    `{type:"fp:activity", v:2, tickets:[...], states:[{ticket, threadId, state}]}`: `tickets` keeps its meaning (working
    only), `states` adds one entry per non-resting ticket thread with `state` `approval`, `input`, `error` (latest run
    `failed`; `interrupted` gives no entry) or `working`; with several signals the rank is approval > input > error > working. The dashboard shows "Agent arbeitet" in
    the ticket picker from it; the signal is transient and writes nothing to OpenProject. Concept:
    Factory `Flightplan V1.0/_meta/planning/KONZEPT-OP1802-TICKET-ZUSTAND-20261110.md`.
16. No start turn on the first open of a ticket (OP#1840, reverses OP#1802): `_chat.embed.$ticketId.tsx` still creates
    and assigns the thread, but sends no turn (`startAgent: false`). A ticket thread without any turn
    (`latestUserMessageAt` and `latestRun` empty, `ticketAwaitsStart`) shows the button "Zusammenfassung holen" in the
    ticket bar; one click sends the former start turn (`ticketStartPrompt`, state summary, open decisions, questions,
    change nothing) via `sendTicketStart`, the button is disabled while sending and disappears once the thread has a
    turn. The compact workplace embed starts nothing, as before. `fp:start` (item 17) is the way to start an agent
    without opening. The ticket block goes out while the thread has no user message yet (`useComposerSend.ts`).
    Runtime mode (OP#1841): new ticket threads (embed route and `fp:start`) use `TICKET_RUNTIME_MODE = "auto"`,
    which `ClaudeAdapterV2.permissionModeForClaudeRuntimePolicy` maps to the Claude Code `auto` permission mode.
    Existing threads keep theirs. The ticket bar shows the thread's mode as "Modus".

17. Background start and continuation (OP#1840, contract Phase 2a section 4). All messages come from
    `http://localhost:8090` only and are handled by `FlightplanActivity` (full layout), which registers the turn host of
    `channel.ts`. Text from a message is only the text of a turn, never HTML; `answer`/`text`/`note` are cut at 4000
    characters; `ticket` must be a positive integer. A turn goes only into the thread the server record
    (`/api/flightplan/tickets/<n>`) assigns to the ticket, never by title, with the model and mode the thread has.
    A thread that waits for an approval or an input gets no turn.
    - `{type:"fp:start", ticket}` (OP to T3): creates the ticket's thread if none is assigned (`createTicketThread` in
      `ticketThread.ts`, also used by the embed route) and sends the start turn, without navigating. A resting thread
      is reused. Reply `{type:"fp:started", ticket, threadId|null, result:"accepted"|"rejected", reason:null|"slots"|"running"|"error"}`:
      `running` when the ticket's thread has a turn or waits for the human (or a start for it is under 15 s old),
      `slots` when `TICKET_SLOT_LIMIT` (4) other tickets are `working` (state logic of fp:activity v2), `error` on a
      failure, a missing host or a deleted thread. The first open of item 16 starts nothing.
    - The start turn of `fp:start` (new and resting thread) is `ticketWorkPrompt`: same first sentence as
      `ticketStartPrompt` (the server reads the ticket number for the assumption rule from it), then "Maintainer released the
      background start; read ticket and comments, take it over, work it now to the result (own branch and worktree,
      tests, PR), record decisions inside the approved plan as assumptions, ask about reserved topics, finish with the
      closing statement". The button "Zusammenfassung holen" keeps `ticketStartPrompt` (summary only, changes nothing).
    - `{type:"fp:answered", questionId, ok:true, ticket, answer}`: besides the display, sends the turn
      `Antwort auf die Rückfrage: <answer>` into the ticket's thread, also when it is not the open one. Once per
      `questionId` and browser (`sessionStorage` key `fp:answered-forwarded`). Without `ticket`/`answer` or with
      `ok:false` it stays display only.
    - `{type:"fp:assumption", ticket, assumptionId, decision:"confirmed"|"rejected", text, note|null}`: sends
      `Annahme bestätigt: <text>` or `Annahme verworfen: <text>. Hinweis: <note>. Baue nicht weiter darauf auf.`
      Once per `assumptionId` (`fp:assumption-forwarded`).
      Review follow-up (Nachtrag 1): the channel listener also requires `event.source === window.parent`. `fp:start`
      answers `rejected`/`error` until all environments delivered their thread shells (`useAllEnvironmentShellsBootstrapped`).
      If the server record already belongs to another thread (another tab was faster), `fp:start` answers
      `rejected`/`running` and deletes its own empty thread (`thread.delete` with `onlyIfUnused`). Turns for answers
      and assumptions use `dispatchMode: "queue"`, so they wait behind a running turn and never steer or interrupt it.
    - `{type:"fp:forwarded", kind:"answer"|"assumption", id, ticket, result:"sent"|"pending"|"no-thread"}` (T3 to OP)
      after each attempt. `pending`: threads not loaded, host not registered, or the thread waits for approval or
      input. Such items are kept in `sessionStorage` (`fp:forward-pending`, at most 20, dropped after 24 h) and tried
      again on the activity beat (on change and every 30 s) and when the host registers; `sent` is reported then.
      `no-thread`: the ticket has no thread (not kept). An item is sent at most once (`fp:answered-forwarded`,
      `fp:assumption-forwarded`).

18. Open requests and answers from the dashboard (OP#1842, contract Phase 3 sections 1 and 2). Code in
    `apps/web/src/flightplan/requests.ts`, host in `FlightplanActivity`; `channel.ts` only dispatches via
    `registerParentHandler`, so origin and `event.source` checks apply unchanged. Web only, no server change besides item 14a.
    - `{type:"fp:requests-get", ticket}` (OP to T3): the thread is the one the server record assigns to the ticket. If it
      waits for approval or input (shell flags), its detail is subscribed through `environmentThreadDetails.quietThreadAtom`
      (the open thread is not required; no subscription for other threads) and `derivePendingThreadRequests` is mapped.
      Reply `{type:"fp:requests", ticket, threadId|null, items:[{requestId, kind:"question"|"approval", createdAt, answerable,
      question?:{text, options:[{label, description|null, recommended}], multiSelect}, approval?:{detail, reason|null, tool|null}}]}`.
      `threadId` is null (items empty) when no thread is assigned. `answerable:false`: several questions, multiSelect,
      a question that is not `live`, no custom answer and no options, or an approval that is not a `command`, not `live`,
      whose options lack accept or decline, or whose `detail` does not equal the input of a `command_execution` item of the
      thread and is at most 8000 characters without bidi controls (U+202A-202E, U+2066-2069), zero-width characters
      (U+200B-200F, U+2060, U+FEFF) or control characters other than `\n` and `\t` (the text is still reported unchanged); only then is detail the whole command: Claude shows a title or a 400-character summary for tools other than
      Bash, Codex shows `reason` before the command). `recommended`: label ends with "(Recommended)" or "(Empfohlen)".
    - Queried tickets are remembered (at most 50, in memory). On every activity beat (shell change, every 30 s with a
      fresh server lookup) `refreshRequestWatches` starts a subscription for a queried ticket whose thread waits (at most 12),
      sends `fp:requests` again when the items changed, and releases the subscription after sending empty items.
      If the detail does not arrive within 8 s, empty items are sent once; a later arrival sends the real ones.
    - `{type:"fp:respond", ticket, threadId, requestId, kind:"question", optionLabel | text}` or
      `{..., kind:"approval", decision:"accept"|"decline", detail}` (`detail` = the command text the dashboard showed; it must equal the
      open request's `detail`, else `gone` and nothing is released); reply `{type:"fp:responded", ticket, requestId, result:"ok"|"gone"|"error"}`.
      `threadId` must equal the server record of the ticket, the request must be pending in that thread. `optionLabel` must equal
      an option label exactly (the provider `value` is sent when the option has one); `text` is cleaned like item 17 and
      cut at 4000 characters, refused when the question disallows custom answers. Approvals use only the decisions
      `accept` and `decline` (single use), never `acceptForSession`, `acceptAlways` or a mode change. Each
      `requestId` is answered once (memory plus `sessionStorage` key `fp:responded`); a repeat gets `gone`; a failed send
      is not consumed and answers `gone` when the live watch no longer lists the request. The answer goes through `respondToApproval`/`respondToUserInput` with the explicit `threadId`;
      the chat's own hook (`usePendingThreadRequests`) is unchanged.

Update: merge a new upstream tag into `flightplan/main`. Details in the Factory repo,
`openproject/chat/README.md`.
