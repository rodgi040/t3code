import { useSyncExternalStore } from "react";

import type { ProviderInstanceId } from "@t3tools/contracts";

import { getFlightplanChat, subscribeFlightplanChat, sendAnswer } from "./channel";
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

export function FlightplanComposer({
  activeInstanceId,
  entries,
  tokens,
  onSelect,
}: {
  readonly activeInstanceId: string | null;
  readonly entries: readonly ModelEntry[];
  readonly tokens: TokenLine | null;
  readonly onSelect: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const chat = useSyncExternalStore(subscribeFlightplanChat, getFlightplanChat, getFlightplanChat);
  const chip = chat.context ? `#${chat.context.id} ${chat.context.subject}` : null;

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
      {/* Flightplan OP#1710: answered questions stay visible with the chosen answer. */}
      {chat.answered.map((entry) => (
        <p
          key={`done-${entry.id}`}
          role="status"
          className="rounded-md border p-2"
          data-fp-answered={entry.id}
        >
          Beantwortet: {entry.answer}
          {entry.question ? ` (${entry.question})` : ""}
          {entry.status ? ` · Status jetzt ${entry.status}` : ""}
        </p>
      ))}
      {chat.questions.map((item) => (
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
        {chat.traceId ? ` · Trace ${chat.traceId}` : ""}
      </p>
    </div>
  );
}
