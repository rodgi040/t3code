export const FLIGHTPLAN_TARGETS = [
  { instanceId: "claudeAgent", label: "Claude Code" },
  { instanceId: "flightplanA2a", label: "Gandalf" },
  { instanceId: "flightplanAgentscope", label: "AgentScope" },
] as const;

export function modelForTarget(
  instanceId: string,
  models: readonly { readonly slug: string }[],
): string {
  if (instanceId === "flightplanA2a") return "flightplan";
  if (instanceId === "flightplanAgentscope") return "agentscope";
  return models[0]?.slug ?? "";
}
