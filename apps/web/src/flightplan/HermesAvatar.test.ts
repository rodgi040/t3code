import { describe, expect, it } from "vitest";

import { FP_HERMES_INSTANCE_ID, isHermesInstance } from "./HermesAvatar";
import { FLIGHTPLAN_TARGETS } from "./targets";

describe("Flightplan OP#1703 Hermes avatar", () => {
  it("matches only the A2A target instance", () => {
    expect(FLIGHTPLAN_TARGETS.some((t) => t.instanceId === FP_HERMES_INSTANCE_ID)).toBe(true);
    expect(isHermesInstance("flightplanA2a")).toBe(true);
    expect(isHermesInstance("claudeAgent")).toBe(false);
    expect(isHermesInstance("flightplanAgentscope")).toBe(false);
    expect(isHermesInstance(null)).toBe(false);
  });
});
