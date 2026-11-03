import { describe, expect, it } from "vite-plus/test";

import { enrichFlightplanPrompt, takeTraceMarker, ticketIds } from "./prompt.ts";

describe("flightplan prompt", () => {
  it("collects ticket ids once", () => {
    expect(ticketIds("siehe #12 und nochmal #12 sowie #7")).toEqual(["12", "7"]);
  });

  it("strips the trace marker and appends ticket text from the runner", async () => {
    const marked = takeTraceMarker("Hallo [[fp-trace:11111111-1111-4111-8111-111111111111]]");
    expect(marked.traceId).toBe("11111111-1111-4111-8111-111111111111");
    expect(marked.text).toBe("Hallo");

    const text = await enrichFlightplanPrompt({
      text: "Bitte #15 [[fp-trace:11111111-1111-4111-8111-111111111111]]",
      driver: "claudeAgent",
      run: async (id) => ({ id, ok: true, body: "Betreff: Probe" }),
      trace: async (id) => id,
    });
    expect(text).toContain("Ticket #15");
    expect(text).toContain("Betreff: Probe");
    expect(text).toContain("CLI fp-op");
    expect(text).toContain("Trace: 11111111-1111-4111-8111-111111111111");
    expect(text).not.toContain("[[fp-trace:");
  });

  it("keeps the message when the ticket cannot be loaded", async () => {
    const text = await enrichFlightplanPrompt({
      text: "Schau #9",
      driver: "acpRegistry",
      run: async (id) => ({ id, ok: false, body: "" }),
      trace: async () => null,
    });
    expect(text).toContain("Schau #9");
    expect(text).toContain("konnte nicht geladen werden");
    expect(text).not.toContain("CLI fp-op");
  });
});
