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
  describe("assumption rule", () => {
    const block = (id: number) =>
      `<ticket-context source="openproject" trust="untrusted-data">\nTicket #${id}\nTitel: x\n</ticket-context>\nHinweis\n\n`;
    const run = (text: string, firstTurn = true, driver = "claudeAgent") =>
      enrichFlightplanPrompt({
        text,
        driver,
        firstTurn,
        run: async (id) => ({ id, ok: true, body: "x" }),
        trace: async () => null,
      });
    const withSwitch = async (value: string | undefined, fn: () => Promise<void>) => {
      const old = process.env.T3CODE_FP_ASSUMPTION_RULE;
      if (value === undefined) delete process.env.T3CODE_FP_ASSUMPTION_RULE;
      else process.env.T3CODE_FP_ASSUMPTION_RULE = value;
      try {
        await fn();
      } finally {
        if (old === undefined) delete process.env.T3CODE_FP_ASSUMPTION_RULE;
        else process.env.T3CODE_FP_ASSUMPTION_RULE = old;
      }
    };

    it("leaves the prompt unchanged when the switch is off", async () => {
      await withSwitch(undefined, async () => {
        expect(await run(block(1838) + "Los")).not.toContain("fp-op assume");
      });
      await withSwitch("0", async () => {
        expect(await run(block(1838) + "Los")).not.toContain("fp-op assume");
      });
    });

    it("adds the rule with the block's ticket number and all reserved topics", async () => {
      await withSwitch("1", async () => {
        const first = await run(block(1838) + "Los");
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
      });
    });

    it("takes the number from the dashboard start turn", async () => {
      await withSwitch("1", async () => {
        const out = await run("Ticket #77 wurde im ADA-Dashboard geöffnet.\nFasse zusammen.");
        expect(out).toContain("fp-op assume 77 --text");
      });
    });

    it("adds no rule without a fixed start, on later turns or other drivers", async () => {
      await withSwitch("1", async () => {
        expect(await run("Was ist mit #5?")).not.toContain("fp-op assume");
        expect(await run("Nimm Variante #2")).not.toContain("fp-op assume");
        // Text before the block: the block parser (anchored at the start) does not accept it, so neither do we.
        expect(await run("Siehe #123\n\n" + block(9) + "Los")).not.toContain("fp-op assume");
        expect(await run(block(1838) + "Weiter", false)).not.toContain("fp-op assume");
        expect(await run(block(1838) + "Los", true, "acpRegistry")).not.toContain("fp-op assume");
      });
    });
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
