import { useState, useSyncExternalStore } from "react";

import type { ProviderInstanceId } from "@t3tools/contracts";

import {
  COMMENT_MAX_LENGTH,
  eventLine,
  getFlightplanChat,
  resetCommentStatus,
  sendAnswer,
  sendComment,
  subscribeFlightplanChat,
  ticketForThread,
} from "./channel";
import { flightplanFrameFull } from "./embed";
import { HermesAvatar, isHermesInstance } from "./HermesAvatar";
import { FLIGHTPLAN_TARGETS, modelForTarget } from "./targets";

interface ModelEntry {
  readonly instanceId: string;
  readonly models: readonly { readonly slug: string }[];
}

interface TokenLine {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cost: { readonly amount: number; readonly currency: string } | null;
}

// Flightplan OP#1711 wave 2: history of the open ticket as system lines. Display only: the lines are plain text and
// never reach the agent as a prompt.
function TicketHistory({ lines }: { readonly lines: readonly { id: string; text: string }[] }) {
  if (lines.length === 0) return null;
  return (
    <ul
      className="max-h-[18vh] min-h-14 shrink-0 overflow-y-auto rounded-md border p-2 text-muted-foreground"
      aria-label="Verlauf des Tickets"
      data-fp-history="true"
    >
      {lines.map((line) => (
        <li key={line.id} data-fp-event={line.id}>
          {line.text}
        </li>
      ))}
    </ul>
  );
}

// Flightplan OP#1711 wave 2: a message for the ticket becomes a comment in the name of the signed-in human, after an
// explicit confirmation with ticket and text. Saved is not delivered: the agent reads it on its next read.
export function TicketComment({
  wpId,
  title,
  lines,
}: {
  readonly wpId: number;
  readonly title: string;
  readonly lines: readonly { id: string; text: string }[];
}) {
  const chat = useSyncExternalStore(subscribeFlightplanChat, getFlightplanChat, getFlightplanChat);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const status = chat.comment;
  const pending = status.state === "pending";
  const tooLong = draft.length > COMMENT_MAX_LENGTH;
  const own = "wpId" in status && status.wpId === wpId;
  const saved = own && status.state === "saved";
  // The text moves out of the box when it is sent; after an error it can be taken back.
  const [sent, setSent] = useState("");

  // On a short pane the confirmation, the error and the saved note must fit: the history steps aside meanwhile.
  const feedback = confirming || status.state === "error" || saved;

  return (
    <>
      <div
        className="flex shrink-0 flex-col gap-1 rounded-md border p-2"
        data-fp-comment-box="true"
      >
        {confirming ? (
          <div
            className="flex flex-col gap-1"
            role="group"
            aria-label="Als Kommentar speichern?"
            // The box must lie fully inside the visible pane, buttons included (short iframe viewport).
            ref={(node) => node?.scrollIntoView({ block: "nearest" })}
          >
            <p>
              <strong>#{wpId}</strong> {title}
            </p>
            <p className="whitespace-pre-wrap" data-fp-comment-preview="true">
              {draft.trim()}
            </p>
            <p>Als Kommentar speichern?</p>
            <div className="flex gap-1">
              <button
                type="button"
                data-fp-comment-confirm="true"
                disabled={pending}
                onClick={() => {
                  if (sendComment(wpId, draft)) {
                    setSent(draft);
                    setDraft("");
                    setConfirming(false);
                  }
                }}
              >
                Ja, speichern
              </button>
              <button type="button" disabled={pending} onClick={() => setConfirming(false)}>
                Abbrechen
              </button>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim() && !tooLong) {
                resetCommentStatus();
                setConfirming(true);
              }
            }}
          >
            <textarea
              name="comment"
              rows={2}
              value={draft}
              maxLength={COMMENT_MAX_LENGTH + 1}
              placeholder={`Kommentar an #${wpId} (nicht an den Agent)`}
              aria-label={`Kommentar an #${wpId}`}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" disabled={pending || !draft.trim() || tooLong}>
              {pending ? "Wird gespeichert …" : "Als Kommentar speichern …"}
            </button>
          </form>
        )}
        {saved ? (
          <p
            role="status"
            data-fp-comment-saved="true"
            ref={(node) => node?.scrollIntoView({ block: "nearest" })}
          >
            Als Kommentar gespeichert – kommt beim nächsten Lesen an.
          </p>
        ) : null}
        {own && status.state === "error" ? (
          <div
            className="flex flex-col items-start gap-1"
            data-fp-comment-error="true"
            ref={(node) => node?.scrollIntoView({ block: "nearest" })}
          >
            <p role="alert" className="text-destructive">
              {status.error}
            </p>
            {sent && !draft ? (
              <button type="button" onClick={() => setDraft(sent)}>
                Text zurückholen
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {feedback ? null : <TicketHistory lines={lines} />}
    </>
  );
}

export function FlightplanComposer({
  threadId,
  activeInstanceId,
  entries,
  tokens,
  onSelect,
}: {
  readonly threadId: string | null;
  readonly activeInstanceId: string | null;
  readonly entries: readonly ModelEntry[];
  readonly tokens: TokenLine | null;
  readonly onSelect: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const chat = useSyncExternalStore(subscribeFlightplanChat, getFlightplanChat, getFlightplanChat);
  // Flightplan OP#1784: in the dashboard split the ticket parts live in the ticket bar under the header; the composer
  // keeps only the target chips and the token line. The compact embed (workplace page) is unchanged.
  const full = flightplanFrameFull();
  const ticket = full ? null : ticketForThread(chat, threadId);
  const chip = ticket ? `#${ticket.id} ${ticket.subject}` : null;
  const ticketId = ticket?.id ?? null;
  const questions = full ? [] : chat.questions;
  const answered = full ? [] : chat.answered;
  const lines =
    ticketId !== null && chat.eventsFor === ticketId
      ? chat.events.map((event) => ({ id: event.id, text: eventLine(event) }))
      : [];

  return (
    // Flightplan OP#1705: an open question may not take the whole narrow pane.
    <div
      className="mb-2 flex max-h-[45vh] flex-col gap-2 overflow-y-auto text-sm"
      data-flightplan-composer="true"
    >
      <div className="flex flex-wrap gap-1" role="group" aria-label="Ziel">
        {FLIGHTPLAN_TARGETS.map((target) => {
          const entry = entries.find((candidate) => candidate.instanceId === target.instanceId);
          const selected = activeInstanceId === target.instanceId;
          return (
            <button
              key={target.instanceId}
              type="button"
              data-fp-target={target.instanceId}
              aria-pressed={selected}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-1"
              onClick={() =>
                onSelect(
                  target.instanceId as ProviderInstanceId,
                  modelForTarget(target.instanceId, entry?.models ?? []),
                )
              }
            >
              {/* Flightplan OP#1703: Hermes agent logo on its chip. */}
              {isHermesInstance(target.instanceId) ? <HermesAvatar className="size-4" /> : null}
              {target.label}
            </button>
          );
        })}
      </div>
      {chip ? (
        <span className="w-fit rounded-full border px-2 py-0.5" data-fp-context-chip="true">
          {chip}
        </span>
      ) : null}
      {/* Flightplan OP#1711 wave 2: ticket history (display only) and the comment box with confirmation. */}
      {ticketId !== null ? (
        <TicketComment key={ticketId} wpId={ticketId} title={ticket?.subject ?? ""} lines={lines} />
      ) : null}
      {/* Flightplan OP#1710: answered questions stay visible with the chosen answer. */}
      {answered.map((entry) => (
        <p
          key={`done-${entry.id}`}
          role="status"
          className="rounded-md border p-2"
          data-fp-answered={entry.id}
        >
          Beantwortet: {entry.answer}
          {entry.workPackageId ? ` – #${entry.workPackageId}` : ""}
          {entry.status ? `, Status jetzt ${entry.status}` : ""}
        </p>
      ))}
      {questions.map((item) => (
        <form
          key={item.id}
          className="flex flex-col gap-1 rounded-md border p-2"
          data-fp-question={item.id}
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const selected = form.querySelector<HTMLInputElement>("input[name='option']:checked");
            const text = form.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "";
            // Flightplan OP#1710: pending/ok/error are tracked in channel.ts.
            sendAnswer(item, selected?.value ?? "", text);
          }}
        >
          <p>{item.question}</p>
          {item.context ? <p className="text-muted-foreground">{item.context}</p> : null}
          <div className="flex flex-wrap gap-1">
            {(item.options ?? []).map((option) => (
              <label key={option} className="rounded-full border px-2 py-0.5">
                <input type="radio" name="option" value={option} /> {option}
              </label>
            ))}
          </div>
          <textarea name="text" rows={2} placeholder="Freitext" />
          <button type="submit" disabled={item.id in chat.pending}>
            {item.id in chat.pending ? "Wird gesendet …" : "Antworten"}
          </button>
          {chat.errors[item.id] ? (
            <p role="alert" className="text-destructive" data-fp-answer-error={item.id}>
              {chat.errors[item.id]}
            </p>
          ) : null}
        </form>
      ))}
      <p data-fp-usage="true">
        Tokens ein {tokens?.inputTokens ?? "–"} aus {tokens?.outputTokens ?? "–"}
        {" · "}
        Kosten {tokens?.cost ? `${tokens.cost.amount} ${tokens.cost.currency}` : "im Trace"}
      </p>
    </div>
  );
}
