import { useSyncExternalStore } from "react";

import type { ProviderInstanceId } from "@t3tools/contracts";

import {
  getFlightplanChat,
  subscribeFlightplanChat,
  answerMessage,
  PARENT_ORIGIN,
} from "./channel";
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
              className="rounded-full border px-2 py-1"
              onClick={() =>
                onSelect(
                  target.instanceId as ProviderInstanceId,
                  modelForTarget(target.instanceId, entry?.models ?? []),
                )
              }
            >
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
            window.parent.postMessage(
              answerMessage(item.id, selected?.value ?? "", text),
              PARENT_ORIGIN,
            );
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
          <button type="submit">Antworten</button>
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
