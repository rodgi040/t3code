import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { runtimeModeConfig } from "~/components/chat/runtimeModeConfig";
import { useThreadShells } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

import {
  PARENT_ORIGIN,
  getFlightplanChat,
  sendAnswer,
  subscribeFlightplanChat,
  ticketForThread,
  type FlightplanQuestion,
  type FlightplanWorkPackage,
} from "./channel";
import { flightplanFrameFull } from "./embed";
import { sendTicketStart, ticketAwaitsStart } from "./ticketThread";
import { TicketComment } from "./FlightplanComposer";
import {
  eventTime,
  openProjectLink,
  readTicketBarMemory,
  ticketBarEventLine,
  ticketBarOpen,
  writeTicketBarMemory,
} from "./ticketBar";

const HISTORY_LINES = 5;
const LABELS_SHOWN = 2;

function statusVariant(key: string | undefined) {
  if (key === "progress") return "success" as const;
  if (key === "waiting") return "warning" as const;
  if (key === "review") return "info" as const;
  return "secondary" as const;
}

function Meta({ label, value }: { readonly label?: string; readonly value: string }) {
  return (
    <Badge variant="outline">
      {label ? <span className="font-normal text-muted-foreground">{label}</span> : null}
      {value}
    </Badge>
  );
}

function QuestionBox({
  item,
  pending,
  error,
}: {
  readonly item: FlightplanQuestion;
  readonly pending: string | undefined;
  readonly error: string | undefined;
}) {
  const [own, setOwn] = useState(false);
  const [text, setText] = useState("");
  const busy = pending !== undefined;
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-warning/40 bg-warning/8 p-2.5"
      data-fp-question={item.id}
    >
      <p className="font-medium">Offene Rückfrage</p>
      <p className="whitespace-pre-wrap">{item.question}</p>
      {item.context ? <p className="text-muted-foreground">{item.context}</p> : null}
      <div className="flex flex-wrap gap-1.5">
        {(item.options ?? []).map((option, index) => (
          <Button
            key={option}
            size="xs"
            variant={index === 0 ? "default" : "outline"}
            disabled={busy}
            data-fp-answer-option={option}
            onClick={() => sendAnswer(item, option, "")}
          >
            {option}
          </Button>
        ))}
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          aria-expanded={own}
          onClick={() => setOwn((value) => !value)}
        >
          Eigene Antwort …
        </Button>
      </div>
      {own ? (
        <form
          className="flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim()) sendAnswer(item, "", text);
          }}
        >
          <textarea
            name="text"
            rows={2}
            value={text}
            placeholder="Freitext"
            aria-label="Eigene Antwort"
            className="rounded-md border bg-background p-1.5"
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" size="xs" variant="outline" disabled={busy || !text.trim()}>
            Antworten
          </Button>
        </form>
      ) : null}
      {busy ? <p role="status">Wird gesendet …</p> : null}
      {error ? (
        <p role="alert" className="text-destructive" data-fp-answer-error={item.id}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Description({ text }: { readonly text: string }) {
  const [more, setMore] = useState(false);
  return (
    <div className="min-w-0">
      <p className="mb-0.5 text-2xs uppercase tracking-wide text-muted-foreground">Beschreibung</p>
      <p className={more ? "whitespace-pre-wrap" : "line-clamp-4 whitespace-pre-wrap"}>{text}</p>
      {text.length > 160 ? (
        <Button size="xs" variant="link" onClick={() => setMore((value) => !value)}>
          {more ? "weniger" : "mehr"}
        </Button>
      ) : null}
    </div>
  );
}

/** OP#1840: the first opening starts no turn; this button sends the start turn once, while the thread has none. */
function SummaryButton({
  ticketId,
  shell,
}: {
  readonly ticketId: number;
  readonly shell: ReturnType<typeof useThreadShells>[number];
}) {
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const busy = useRef(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!ticketAwaitsStart(shell)) return null;
  return (
    <>
      <Button
        size="sm"
        disabled={sending}
        data-fp-ticket-start="true"
        onClick={() => {
          if (busy.current) return;
          setSending(true);
          setFailed(false);
          void sendTicketStart({ ticketId: String(ticketId), shell, startTurn, busy })
            .then((ok) => setFailed(!ok))
            .catch(() => setFailed(true))
            .finally(() => setSending(false));
        }}
      >
        {sending ? "Wird gesendet …" : "Zusammenfassung holen"}
      </Button>
      {failed ? (
        <span role="alert" className="text-destructive" data-fp-ticket-start-error="true">
          Nicht gesendet.
        </span>
      ) : null}
    </>
  );
}

function TicketBarBody({
  ticket,
  threadId,
}: {
  readonly ticket: FlightplanWorkPackage;
  readonly threadId: string;
}) {
  const chat = useSyncExternalStore(subscribeFlightplanChat, getFlightplanChat, getFlightplanChat);
  const questions = chat.questions.filter((item) => item.work_package_id === ticket.id);
  const answered = chat.answered.filter((entry) => entry.workPackageId === ticket.id);
  const openIds = questions.map((item) => item.id);
  const [memory, setMemory] = useState(() => readTicketBarMemory(ticket.id));
  const open = ticketBarOpen(memory, openIds);
  const history =
    chat.eventsFor === ticket.id
      ? chat.events
          .flatMap((event) => {
            const text = ticketBarEventLine(event);
            return text ? [{ id: event.id, at: eventTime(event.at), text }] : [];
          })
          .slice(-HISTORY_LINES)
      : [];
  const link = openProjectLink(ticket.url, PARENT_ORIGIN);
  const status = ticket.status_label || ticket.status;
  const labels = (ticket.labels ?? []).slice(0, LABELS_SHOWN);
  const detailsId = `fp-ticket-bar-${threadId}`;
  const shells = useThreadShells();
  const shell = shells.find((item) => item.id === threadId);

  const toggle = () => {
    const next = { open: !open, seen: openIds };
    writeTicketBarMemory(ticket.id, next);
    setMemory(next);
  };

  return (
    <section
      className="shrink-0 border-b bg-background px-3 py-2 text-sm sm:px-5"
      aria-label={`Ticket #${ticket.id}`}
      data-fp-ticket-bar={ticket.id}
      data-open={open ? "true" : "false"}
    >
      <div className="flex items-start gap-2">
        <span className="pt-px text-muted-foreground tabular-nums">#{ticket.id}</span>
        <span className="line-clamp-2 min-w-0 flex-1 font-semibold">{ticket.subject}</span>
        {questions.length > 0 ? (
          <Badge variant="warning" data-fp-ticket-bar-questions={questions.length}>
            {questions.length === 1 ? "1 Rückfrage" : `${questions.length} Rückfragen`}
          </Badge>
        ) : null}
        {status ? (
          <Badge variant={statusVariant(ticket.status_key)} data-fp-ticket-bar-status={status}>
            {status}
          </Badge>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={open ? "Ticket-Details einklappen" : "Ticket-Details aufklappen"}
          data-fp-ticket-bar-toggle="true"
          onClick={toggle}
        >
          <ChevronDownIcon className={open ? "rotate-180" : undefined} />
        </Button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {ticket.project_name || ticket.project ? (
          <Meta label="Projekt" value={ticket.project_name || ticket.project || ""} />
        ) : null}
        {ticket.type ? <Meta label="Typ" value={ticket.type} /> : null}
        {ticket.priority ? <Meta label="Priorität" value={ticket.priority} /> : null}
        {labels.map((label) => (
          <Meta key={label} value={label} />
        ))}
        {ticket.assignee ? <Meta value={`✳ ${ticket.assignee}`} /> : null}
        {shell ? <Meta label="Modus" value={runtimeModeConfig[shell.runtimeMode].label} /> : null}
        {shell ? <SummaryButton ticketId={ticket.id} shell={shell} /> : null}
        {link ? (
          <Button
            size="xs"
            variant="ghost-muted"
            className="ms-auto"
            render={<a href={link} target="_blank" rel="noopener noreferrer" />}
            data-fp-ticket-bar-open="true"
          >
            In OpenProject öffnen
            <ExternalLinkIcon />
          </Button>
        ) : null}
      </div>
      {open ? (
        <div
          id={detailsId}
          className="mt-2 flex max-h-[40vh] flex-col gap-2 overflow-y-auto"
          data-fp-ticket-bar-details="true"
        >
          {ticket.description || history.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {ticket.description ? <Description text={ticket.description} /> : null}
              {history.length > 0 ? (
                <div className="min-w-0">
                  <p className="mb-0.5 text-2xs uppercase tracking-wide text-muted-foreground">
                    Letzter Verlauf
                  </p>
                  <ul aria-label="Verlauf des Tickets" data-fp-history="true">
                    {history.map((line) => (
                      <li key={line.id} data-fp-event={line.id} className="break-words">
                        {line.at ? <span className="text-muted-foreground">{line.at} </span> : null}
                        {line.text}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          {questions.map((item) => (
            <QuestionBox
              key={item.id}
              item={item}
              pending={chat.pending[item.id]}
              error={chat.errors[item.id]}
            />
          ))}
          {answered.map((entry) => (
            <p
              key={`done-${entry.id}`}
              role="status"
              className="rounded-md border p-2"
              data-fp-answered={entry.id}
            >
              Beantwortet: {entry.answer}
              {entry.status ? `, Status jetzt ${entry.status}` : ""}
            </p>
          ))}
          <TicketComment key={ticket.id} wpId={ticket.id} title={ticket.subject} lines={[]} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Flightplan OP#1784: the ticket bar under the chat header in the dashboard split. Only for the thread the dashboard
 * bound to a ticket; any other thread renders nothing at all (no placeholder).
 */
export function FlightplanTicketBar({ threadId }: { readonly threadId: string }) {
  const chat = useSyncExternalStore(subscribeFlightplanChat, getFlightplanChat, getFlightplanChat);
  if (!flightplanFrameFull()) return null;
  const ticket = ticketForThread(chat, threadId, true);
  if (!ticket) return null;
  return <TicketBarBody key={ticket.id} ticket={ticket} threadId={threadId} />;
}
