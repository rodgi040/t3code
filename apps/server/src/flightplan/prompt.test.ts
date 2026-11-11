// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildTurnSpanBody,
  enrichFlightplanPrompt,
  isSlashCommand,
  normalizeTraceId,
  sendTurnSpan,
  startTurnTicket,
  takeTraceMarker,
  ticketIds,
} from "./prompt.ts";

const HEX32 = /^[0-9a-f]{32}$/;
const UUID = "11111111-1111-4111-8111-111111111111";
const UUID_HEX = "11111111111141118111111111111111";

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
    expect(text).toContain(`Trace: ${UUID_HEX}`);
    expect(text).not.toContain("[[fp-trace:");
  });

  // OP#1853
  it("normalizes trace ids to 32 lowercase hex", () => {
    expect(normalizeTraceId(UUID)).toBe(UUID_HEX);
    expect(normalizeTraceId(UUID.toUpperCase())).toBe(UUID_HEX);
    expect(normalizeTraceId(UUID_HEX)).toBe(UUID_HEX);
    expect(normalizeTraceId("xyz")).toBeNull();
    expect(normalizeTraceId("a".repeat(31))).toBeNull();
    expect(normalizeTraceId("0".repeat(32))).toBeNull();
    expect(normalizeTraceId("")).toBeNull();
  });

  // OP#1853
  it("hands the trace function a 32-hex id: from the marker, or fresh when the marker is invalid or missing", async () => {
    const seen: string[] = [];
    const run = (text: string) =>
      enrichFlightplanPrompt({
        text,
        driver: "claudeAgent",
        firstTurn: true,
        run: async (id) => ({ id, ok: true, body: "" }),
        trace: async (id) => {
          seen.push(id);
          return id;
        },
      });
    await run(`Los [[fp-trace:${UUID}]]`);
    expect(seen[0]).toBe(UUID_HEX);
    // 36 marker characters, but 35 hex once the dash is gone.
    const bad = `${"a".repeat(35)}-`;
    await run(`Los [[fp-trace:${bad}]]`);
    expect(seen[1]).toMatch(HEX32);
    expect(normalizeTraceId(bad)).toBeNull();
    await run("Los ohne Marker");
    expect(seen[2]).toMatch(HEX32);
  });

  // OP#1853
  describe("turn span body", () => {
    type Attr = { key: string; value: Record<string, unknown> };
    const build = (extra: { threadId?: string; ticket?: string } = {}) =>
      buildTurnSpanBody({
        traceId: UUID_HEX,
        spanId: "0123456789abcdef",
        nowMs: 1_700_000_000_123,
        ...extra,
      }) as {
        resourceSpans: Array<{
          resource: { attributes: Attr[] };
          scopeSpans: Array<{ scope: { name: string }; spans: Array<Record<string, unknown>> }>;
        }>;
      };
    const span = (body: ReturnType<typeof build>) =>
      body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    const attrs = (list: Attr[]) => Object.fromEntries(list.map((a) => [a.key, a.value]));
    const spanAttrs = (body: ReturnType<typeof build>) => attrs(span(body).attributes as Attr[]);

    it("builds the span header from the given ids and time", () => {
      const s = span(build({ threadId: "thread-1", ticket: "1786" }));
      expect(s.traceId).toBe(UUID_HEX);
      expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(s.name).toBe("t3-fp-claude");
      expect(s.kind).toBe(1);
      expect(s.startTimeUnixNano).toBe(s.endTimeUnixNano);
      expect(s.startTimeUnixNano).toMatch(/^\d+$/);
      expect(s.startTimeUnixNano).toBe("1700000000123000000");
    });

    it("sets exactly the documented attributes for a ticket thread", () => {
      const a = spanAttrs(build({ threadId: "thread-1", ticket: "1786" }));
      expect(Object.keys(a).toSorted()).toEqual(
        [
          "langfuse.observation.type",
          "langfuse.session.id",
          "langfuse.trace.metadata.fp_issue",
          "langfuse.trace.metadata.source",
          "langfuse.trace.metadata.thread_id",
          "langfuse.trace.name",
          "langfuse.trace.tags",
        ].toSorted(),
      );
      expect(a["langfuse.session.id"]).toEqual({ stringValue: "thread-1" });
      expect(a["langfuse.trace.name"]).toEqual({ stringValue: "t3-fp-claude" });
      expect(a["langfuse.observation.type"]).toEqual({ stringValue: "span" });
      expect(a["langfuse.trace.tags"]).toEqual({
        arrayValue: { values: [{ stringValue: "harness:t3-fp" }, { stringValue: "ticket:1786" }] },
      });
      expect(a["langfuse.trace.metadata.source"]).toEqual({ stringValue: "t3-fp" });
      expect(a["langfuse.trace.metadata.thread_id"]).toEqual({ stringValue: "thread-1" });
      expect(a["langfuse.trace.metadata.fp_issue"]).toEqual({ stringValue: "1786" });
    });

    it("names resource and scope t3-fp", () => {
      const body = build();
      expect(attrs(body.resourceSpans[0]!.resource.attributes)).toEqual({
        "service.name": { stringValue: "t3-fp" },
        "langfuse.environment": { stringValue: "t3-fp" },
      });
      expect(body.resourceSpans[0]!.scopeSpans[0]!.scope.name).toBe("t3-fp");
    });

    it("leaves out ticket data without a plain ticket number", () => {
      for (const ticket of [undefined, "", "12a"]) {
        const a = spanAttrs(
          build({ threadId: "thread-1", ...(ticket === undefined ? {} : { ticket }) }),
        );
        expect(a["langfuse.trace.tags"]).toEqual({
          arrayValue: { values: [{ stringValue: "harness:t3-fp" }] },
        });
        expect(a["langfuse.trace.metadata.fp_issue"]).toBeUndefined();
      }
    });

    it("leaves out session and thread id without a thread", () => {
      const a = spanAttrs(build({ ticket: "1786" }));
      expect(a["langfuse.session.id"]).toBeUndefined();
      expect(a["langfuse.trace.metadata.thread_id"]).toBeUndefined();
    });
  });

  // OP#1853
  describe("send turn span", () => {
    const KEYS = "LANGFUSE_PUBLIC_KEY=pk-test\nLANGFUSE_SECRET_KEY=sk-test\n";
    type Call = { url: string; init: RequestInit };
    // Temp config + stubbed fetch; restores env and global afterwards.
    const withSender = async (
      config: string | null,
      reply: (call: Call) => Promise<Response>,
      fn: (calls: Call[]) => Promise<void>,
    ) => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fp-lf-"));
      const file = NodePath.join(dir, "env");
      if (config !== null) NodeFS.writeFileSync(file, config);
      const old = process.env.FP_LANGFUSE_ENV;
      process.env.FP_LANGFUSE_ENV = file;
      const calls: Call[] = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        const call = { url, init };
        calls.push(call);
        return reply(call);
      });
      try {
        await fn(calls);
      } finally {
        vi.unstubAllGlobals();
        if (old === undefined) delete process.env.FP_LANGFUSE_ENV;
        else process.env.FP_LANGFUSE_ENV = old;
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    };
    const ok = async () => new Response("{}", { status: 207 });

    it("posts one OTLP span and returns the 32-hex trace id", async () => {
      await withSender(KEYS, ok, async (calls) => {
        expect(await sendTurnSpan(UUID, "thread-1", "1786")).toBe(UUID_HEX);
        expect(calls).toHaveLength(1);
        const { url, init } = calls[0]!;
        expect(url).toBe("http://127.0.0.1:3200/api/public/otel/v1/traces");
        expect(init.method).toBe("POST");
        const headers = init.headers as Record<string, string>;
        expect(headers["content-type"]).toBe("application/json");
        expect(headers["x-langfuse-ingestion-version"]).toBe("4");
        expect(headers.authorization?.startsWith("Basic ")).toBe(true);
        expect(init.signal).toBeInstanceOf(AbortSignal);
        const body = JSON.parse(String(init.body));
        const span = body.resourceSpans[0].scopeSpans[0].spans[0];
        expect(span.traceId).toBe(UUID_HEX);
        expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
        const byKey = Object.fromEntries(
          span.attributes.map((a: { key: string; value: unknown }) => [a.key, a.value]),
        );
        expect(byKey["langfuse.session.id"]).toEqual({ stringValue: "thread-1" });
        expect(byKey["langfuse.trace.tags"].arrayValue.values).toEqual([
          { stringValue: "harness:t3-fp" },
          { stringValue: "ticket:1786" },
        ]);
        expect(String(init.body)).not.toContain("sk-test");
      });
    });

    it("uses LANGFUSE_HOST without a doubled slash and keeps the fixed environment", async () => {
      await withSender(
        `${KEYS}LANGFUSE_HOST=http://langfuse.test:9/\nLANGFUSE_TRACING_ENVIRONMENT=claude-code\n`,
        ok,
        async (calls) => {
          expect(await sendTurnSpan(UUID_HEX)).toBe(UUID_HEX);
          expect(calls[0]?.url).toBe("http://langfuse.test:9/api/public/otel/v1/traces");
          const body = JSON.parse(String(calls[0]?.init.body));
          expect(body.resourceSpans[0].resource.attributes).toContainEqual({
            key: "langfuse.environment",
            value: { stringValue: "t3-fp" },
          });
        },
      );
    });

    it("does not send for an invalid trace id", async () => {
      await withSender(KEYS, ok, async (calls) => {
        expect(await sendTurnSpan("xyz")).toBeNull();
        expect(await sendTurnSpan("")).toBeNull();
        expect(calls).toHaveLength(0);
      });
    });

    it("fails open without a usable config or a successful response", async () => {
      await withSender(null, ok, async (calls) => {
        expect(await sendTurnSpan(UUID_HEX)).toBeNull();
        expect(calls).toHaveLength(0);
      });
      const asDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fp-lf-dir-"));
      const old = process.env.FP_LANGFUSE_ENV;
      process.env.FP_LANGFUSE_ENV = asDir;
      try {
        expect(await sendTurnSpan(UUID_HEX)).toBeNull();
      } finally {
        if (old === undefined) delete process.env.FP_LANGFUSE_ENV;
        else process.env.FP_LANGFUSE_ENV = old;
        NodeFS.rmSync(asDir, { recursive: true, force: true });
      }
      await withSender("LANGFUSE_PUBLIC_KEY=pk-test\n", ok, async (calls) => {
        expect(await sendTurnSpan(UUID_HEX)).toBeNull();
        expect(calls).toHaveLength(0);
      });
      await withSender(
        KEYS,
        async () => Promise.reject(new Error("down")),
        async () => {
          expect(await sendTurnSpan(UUID_HEX)).toBeNull();
        },
      );
      for (const name of ["AbortError", "TimeoutError"]) {
        await withSender(
          KEYS,
          async () => Promise.reject(new DOMException("timeout", name)),
          async () => {
            expect(await sendTurnSpan(UUID_HEX)).toBeNull();
          },
        );
      }
      await withSender(
        KEYS,
        async () => new Response("no", { status: 500 }),
        async () => {
          expect(await sendTurnSpan(UUID_HEX)).toBeNull();
        },
      );
    });

    it("never uses the old ingestion endpoint", async () => {
      await withSender(KEYS, ok, async (calls) => {
        await sendTurnSpan(UUID_HEX, "thread-1", "1786");
        expect(calls.every((call) => !call.url.includes("/api/public/ingestion"))).toBe(true);
      });
    });
  });

  // OP#1853
  describe("ticket of the span", () => {
    const block = `<ticket-context source="openproject" trust="untrusted-data">\nTicket #42\nTitel: x\n</ticket-context>\nHinweis\n\nLos`;
    const start = "Ticket #77 wurde im ADA-Dashboard geöffnet.\nFasse zusammen.";
    const traced = async (text: string, firstTurn: boolean, ticket?: string) => {
      const seen: Array<string | undefined> = [];
      const out = await enrichFlightplanPrompt({
        text,
        driver: "claudeAgent",
        firstTurn,
        threadId: "thread-1",
        ...(ticket ? { ticket } : {}),
        run: async (id) => ({ id, ok: true, body: "x" }),
        trace: async (id, _thread, found) => {
          seen.push(found);
          return id;
        },
      });
      return { seen, out };
    };

    it("passes the thread's ticket on, also on later turns", async () => {
      expect((await traced("Weiter", false, "1786")).seen).toEqual(["1786"]);
      expect((await traced("Weiter", true, "1786")).seen).toEqual(["1786"]);
    });

    it("falls back to the start form of the text, whatever the turn", async () => {
      for (const firstTurn of [true, false]) {
        expect((await traced(block, firstTurn)).seen).toEqual(["42"]);
        expect((await traced(start, firstTurn)).seen).toEqual(["77"]);
      }
    });

    it("has no ticket without a start form, and the thread's ticket wins", async () => {
      expect((await traced("Was ist mit #123?", true)).seen).toEqual([undefined]);
      expect((await traced(start, true, "1786")).seen).toEqual(["1786"]);
    });

    it("keeps the assumption rule on the start form only", async () => {
      const old = process.env.T3CODE_FP_ASSUMPTION_RULE;
      process.env.T3CODE_FP_ASSUMPTION_RULE = "1";
      try {
        expect((await traced("Los", true, "1786")).out).not.toContain("fp-op assume");
        expect((await traced(start, true, "1786")).out).toContain("fp-op assume 77 --text");
      } finally {
        if (old === undefined) delete process.env.T3CODE_FP_ASSUMPTION_RULE;
        else process.env.T3CODE_FP_ASSUMPTION_RULE = old;
      }
    });
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
        const off = await run(block(1838) + "Los");
        expect(off).not.toContain("fp-op assume");
        expect(off).not.toContain("fp-op ask");
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
        // OP#1842
        expect(first).toContain("fp-op ask 1838 --question");
        expect(first).toContain("--recommend");
        expect(first).toContain("--kind entscheidung|freigabe|zugang|abnahme");
        expect(first).toContain("--reversible oder --irreversible");
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

    it("recognises the ticket in the fp:start work text (OP#1840)", async () => {
      const work = [
        "Ticket #1840 wurde im ADA-Dashboard geöffnet.",
        "Der Maintainer hat den Start im Hintergrund freigegeben.",
        "Lies Ticket und Kommentare, übernimm das Ticket und bearbeite es jetzt.",
      ].join("\n");
      expect(startTurnTicket(work)).toBe("1840");
      await withSwitch("1", async () => {
        const out = await run(work);
        expect(out).toContain("fp-op assume 1840 --text");
        expect(out).toContain("fp-op ask 1840 --question");
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
