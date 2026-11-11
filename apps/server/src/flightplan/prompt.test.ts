import { describe, expect, it } from "vite-plus/test";

import { enrichFlightplanPrompt, isSlashCommand, takeTraceMarker, ticketIds } from "./prompt.ts";

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
      firstTurn: true,
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
      firstTurn: true,
      run: async (id) => ({ id, ok: false, body: "" }),
      trace: async () => null,
    });
    expect(text).toContain("Schau #9");
    expect(text).toContain("konnte nicht geladen werden");
    expect(text).not.toContain("CLI fp-op");
  });

  // OP#1803
  it("sends the session context only with the first turn", async () => {
    const traced: Array<[string, string | undefined]> = [];
    const later = await enrichFlightplanPrompt({
      text: "Und jetzt weiter",
      driver: "claudeAgent",
      firstTurn: false,
      threadId: "thread-1",
      run: async (id) => ({ id, ok: true, body: "" }),
      trace: async (id, threadId) => {
        traced.push([id, threadId]);
        return id;
      },
    });
    expect(later).toBe("Und jetzt weiter");
    // The trace still exists per turn; the thread ties it together instead of the prompt text.
    expect(traced).toHaveLength(1);
    expect(traced[0]?.[1]).toBe("thread-1");
  });

  // OP#1838
  it("adds the assumption rule with the ticket number, only with the first turn", async () => {
    const args = {
      driver: "claudeAgent",
      run: async (id: string) => ({ id, ok: true, body: "x" }),
      trace: async (id: string) => id,
    };
    const first = await enrichFlightplanPrompt({ ...args, text: "Arbeite an #1838", firstTurn: true });
    expect(first).toContain("fp-op assume 1838 --text");
    expect(first).toContain("fp-op result 1838 --stdin");
    expect(first).toContain("Es darf nur eine Annahme offen sein");
    expect(first).toContain("merge nicht");
    for (const topic of [
      "Deploy, Release, Einspielen",
      "Host, Docker, Firewall, SSH, Ports, DNS",
      "Secrets und Rotation",
      "Löschen und alles Unumkehrbare",
      "Geld, Budget, Modellwahl",
      "Kunden, Versand, Verträge",
      "Scope und Priorität",
      "Architektur und Zuständigkeit",
      "Prüfer-Befunde",
      "Überspringen eines Gates",
    ]) {
      expect(first).toContain(topic);
    }
    const later = await enrichFlightplanPrompt({ ...args, text: "Weiter mit #1838", firstTurn: false });
    expect(later).not.toContain("fp-op assume");
    const other = await enrichFlightplanPrompt({
      ...args,
      driver: "acpRegistry",
      text: "Arbeite an #1838",
      firstTurn: true,
    });
    expect(other).not.toContain("fp-op assume");
  });

  it("passes slash commands through unchanged, on any turn", async () => {
    const calls: string[] = [];
    for (const firstTurn of [true, false]) {
      for (const text of [
        "/goal clear",
        "/goal clear\n\n[[fp-trace:11111111-1111-4111-8111-111111111111]]",
        "/compact",
        "/goal Ticket #15 fertig machen",
      ]) {
        const out = await enrichFlightplanPrompt({
          text,
          driver: "claudeAgent",
          firstTurn,
          run: async (id) => {
            calls.push(id);
            return { id, ok: true, body: "x" };
          },
          trace: async (id) => {
            calls.push(id);
            return id;
          },
        });
        expect(out).toBe(text.replace(/\s*\[\[fp-trace:[^\]]+\]\]/, ""));
      }
    }
    expect(calls).toEqual([]);
  });

  it("tells commands from paths and plain text", () => {
    expect(isSlashCommand("/goal clear")).toBe(true);
    expect(isSlashCommand("  /clear")).toBe(true);
    expect(isSlashCommand("/root/foo ist kaputt")).toBe(false);
    expect(isSlashCommand("Bitte /goal erklären")).toBe(false);
  });
});
