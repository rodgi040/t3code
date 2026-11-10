import { describe, expect, it } from "vite-plus/test";

import type { FlightplanEvent } from "./channel";
import { cleanEventText, openProjectLink, ticketBarEventLine, ticketBarOpen } from "./ticketBar";

function comment(text: string, author = "github-sync"): FlightplanEvent {
  return { id: "c1", kind: "comment", at: "", author, text, from: "", to: "", source: "" };
}

describe("ticket bar history (OP#1784)", () => {
  it("turns machine comments into a short line or drops them", () => {
    expect(
      cleanEventText(
        "<!-- fp-op-sync claim d4d2 --> <!-- fp-claim v1 event=claim session=claude-sub-161 at=2026-11-08T10:17:03Z --> Agent: Sonnet",
      ),
    ).toBe("Claim (claim): claude-sub-161 · Agent: Sonnet");
    expect(cleanEventText("claim claude:op-1784")).toBe("Claim: claude:op-1784");
    expect(cleanEventText("<!-- fp-op-wp:1784 -->\nVerknüpfung mit GitHub")).toBe(
      "Verknüpfung mit GitHub",
    );
    expect(cleanEventText("<!-- fp-op-sync pr https://x/1 Review --> PR offen: https://x/1")).toBe(
      "PR offen: https://x/1",
    );
    expect(cleanEventText("<!-- nur Maschine -->")).toBe("");
    expect(cleanEventText("Text <!-- abgeschnitten")).toBe("Text");
    expect(ticketBarEventLine(comment("<!-- fp-op-wp:1 -->"))).toBeNull();
    expect(ticketBarEventLine(comment("Bitte prüfen", "Rodrigo"))).toBe("Rodrigo: Bitte prüfen");
  });
});

describe("ticket bar open state (OP#1784)", () => {
  it("starts closed, opens for an open question and keeps the user's choice until a new question", () => {
    expect(ticketBarOpen(null, [])).toBe(false);
    expect(ticketBarOpen(null, [7])).toBe(true);
    expect(ticketBarOpen({ open: false, seen: [7] }, [7])).toBe(false);
    expect(ticketBarOpen({ open: false, seen: [7] }, [7, 8])).toBe(true);
    expect(ticketBarOpen({ open: true, seen: [] }, [])).toBe(true);
  });

  it("links into OpenProject only for relative paths or http(s)", () => {
    expect(openProjectLink("/work_packages/1", "http://localhost:8090")).toBe(
      "http://localhost:8090/work_packages/1",
    );
    expect(openProjectLink("//evil.example/x", "http://localhost:8090")).toBeNull();
    expect(openProjectLink("javascript:alert(1)", "http://localhost:8090")).toBeNull();
    expect(openProjectLink(undefined, "http://localhost:8090")).toBeNull();
  });
});
