// Flightplan OP#1703: the Hermes agent (A2A instance "Gandalf") shows its logo instead of the
// default provider symbol. White round backdrop keeps the black hair readable in both themes.
import hermesAgentUrl from "./hermes-agent.png";

import { cn } from "~/lib/utils";

export const FP_HERMES_INSTANCE_ID = "flightplanA2a";

export function isHermesInstance(instanceId: string | null | undefined): boolean {
  return instanceId === FP_HERMES_INSTANCE_ID;
}

export function HermesAvatar({ className }: { readonly className?: string | undefined }) {
  return (
    <img
      src={hermesAgentUrl}
      alt=""
      aria-hidden
      draggable={false}
      data-fp-hermes-avatar="true"
      className={cn("size-5 shrink-0 rounded-full bg-white object-cover", className)}
    />
  );
}
