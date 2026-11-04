import { describe, expect, it, vi } from "vite-plus/test";

import {
  PARENT_ORIGIN,
  acceptParentOrigin,
  answerMessage,
  applyParentMessage,
  helloMessage,
  getFlightplanChat,
  stampClaudeTrace,
  withTicketStartContext,
} from "./channel";

describe("flightplan parent channel", () => {
  it("asks the parent for ticket context once the listener is up", () => {
    expect(helloMessage()).toEqual({ type: "fp:hello" });
  });

  it("ignores a foreign origin", () => {
    expect(acceptParentOrigin("http://evil.example")).toBe(false);
    expect(acceptParentOrigin("http://localhost:8092")).toBe(false);
    expect(
      applyParentMessage(
        { type: "fp:context", wp: { id: 1, subject: "Nein" } },
        "http://evil.example",
      ),
    ).toBe(false);
  });

  it("accepts context and questions only from OpenProject", () => {
    expect(acceptParentOrigin(PARENT_ORIGIN)).toBe(true);
    expect(
      applyParentMessage(
        { type: "fp:context", wp: { id: 123, subject: "Titel", project: "factory" } },
        PARENT_ORIGIN,
      ),
    ).toBe(true);
    expect(getFlightplanChat().context?.subject).toBe("Titel");
    expect(
      applyParentMessage(
        { type: "fp:questions", items: [{ id: 7, question: "Weiter?" }] },
        PARENT_ORIGIN,
      ),
    ).toBe(true);
    expect(getFlightplanChat().questions[0]?.id).toBe(7);
  });

  it("posts the answer to the OpenProject origin", () => {
    const parent = { postMessage: vi.fn() };
    parent.postMessage(answerMessage(7, "ja", "passt"), PARENT_ORIGIN);
    expect(parent.postMessage).toHaveBeenCalledWith(
      { type: "fp:answer", id: 7, option: "ja", text: "passt" },
      PARENT_ORIGIN,
    );
    expect(parent.postMessage.mock.calls[0]?.[1]).not.toBe("*");
  });

  it("prefixes the outgoing prompt with the ticket context once", () => {
    applyParentMessage(
      {
        type: "fp:context",
        wp: {
          id: 1132,
          subject: "Arbeitsplatz",
          status: "In Arbeit",
          url: "/work_packages/1132",
          description: "Kurz",
        },
      },
      PARENT_ORIGIN,
    );
    const prefixed = withTicketStartContext("Was ist offen?");
    expect(prefixed).toContain("Ticket #1132");
    expect(prefixed).toContain("Titel: Arbeitsplatz");
    expect(prefixed).toContain("Was ist offen?");
    expect(withTicketStartContext("Siehe #1132")).toBe("Siehe #1132");
  });

  it("stamps a trace marker only for Claude Code", () => {
    const stamped = stampClaudeTrace("Hallo", "claudeAgent");
    expect(stamped).toMatch(/\[\[fp-trace:[0-9a-f-]{36}\]\]/);
    expect(getFlightplanChat().traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stampClaudeTrace("Hallo", "flightplanA2a")).toBe("Hallo");
  });
});
