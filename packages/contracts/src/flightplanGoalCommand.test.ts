import { describe, expect, it } from "vite-plus/test";

import { parseGoalCommand } from "./orchestrationV2.ts";

// Flightplan OP#1803
describe("parseGoalCommand with a stale trace marker", () => {
  it("reads /goal clear as clear, not as a new goal", () => {
    expect(
      parseGoalCommand({
        text: "/goal clear\n\n[[fp-trace:11111111-1111-4111-8111-111111111111]]",
      }),
    ).toEqual({ type: "clear" });
    expect(parseGoalCommand({ text: "/goal clear" })).toEqual({ type: "clear" });
    expect(parseGoalCommand({ text: "/goal Ticket fertig machen" })).toEqual({
      type: "set",
      objective: "Ticket fertig machen",
    });
  });
});
