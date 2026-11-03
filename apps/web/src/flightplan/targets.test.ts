import { describe, expect, it } from "vite-plus/test";

import { FLIGHTPLAN_TARGETS, modelForTarget } from "./targets";

describe("flightplan targets", () => {
  it("maps the three chat targets onto their provider instances", () => {
    expect(FLIGHTPLAN_TARGETS.map((target) => target.instanceId)).toEqual([
      "claudeAgent",
      "flightplanA2a",
      "flightplanAgentscope",
    ]);
    expect(modelForTarget("flightplanA2a", [])).toBe("flightplan");
    expect(modelForTarget("flightplanAgentscope", [])).toBe("agentscope");
    expect(modelForTarget("claudeAgent", [{ slug: "claude-sonnet" }])).toBe("claude-sonnet");
  });
});
