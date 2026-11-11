import { describe, expect, it } from "vite-plus/test";

import { captureFrameLayout } from "./embed";
import {
  getFlightplanChat,
  reportActivity,
  shellActivityState,
  shellIsWorking,
  ticketActivityStates,
  workingTickets,
} from "./channel";

// Flightplan OP#1802
describe("agent activity per ticket", () => {
  it("counts a turn in flight, not one that waits for the human", () => {
    const running = { status: "running" };
    expect(shellIsWorking({ runtime: running })).toBe(true);
    expect(shellIsWorking({ runtime: { status: "starting" } })).toBe(true);
    expect(shellIsWorking({ runtime: running, hasPendingApprovals: true })).toBe(false);
    expect(shellIsWorking({ runtime: running, hasPendingUserInput: true })).toBe(false);
    expect(shellIsWorking({ runtime: { status: "waiting" } })).toBe(false);
    expect(shellIsWorking({ runtime: { status: "idle" } })).toBe(false);
    expect(shellIsWorking({ runtime: null })).toBe(false);
  });

  it("reports several tickets at once and only threads the server maps to the ticket", async () => {
    const lookups: number[] = [];
    const lookup = async (ticketId: number) => {
      lookups.push(ticketId);
      return { threadId: ticketId === 1609 ? "t-1609" : ticketId === 1636 ? "t-1636" : "other" };
    };
    const shells = [
      { id: "t-1636", title: "#1636 Zweites Ticket", runtime: { status: "running" } },
      { id: "t-1609", title: "#1609 Wiki-Seiten", runtime: { status: "preparing" } },
      { id: "t-idle", title: "#1700 Ruht", runtime: { status: "idle" } },
      { id: "t-fake", title: "#1711 nur so benannt", runtime: { status: "running" } },
      { id: "t-free", title: "Freier Chat", runtime: { status: "running" } },
    ];
    expect(await workingTickets(getFlightplanChat(), shells, lookup)).toEqual([1609, 1636]);
    expect(lookups.toSorted()).toEqual([1609, 1636, 1711]);
    // A verified thread is not looked up again.
    lookups.length = 0;
    expect(await workingTickets(getFlightplanChat(), shells.slice(0, 2), lookup)).toEqual([
      1609, 1636,
    ]);
    expect(lookups).toEqual([]);
  });
});

// Flightplan OP#1834
describe("fp:activity v2 states", () => {
  const lookup = async (ticketId: number) => ({ threadId: `t-${ticketId}` });
  const shell = (n: number, rest: object) => ({ id: `t-${n}`, title: `#${n} x`, ...rest });

  it("names the four states and leaves resting threads out", async () => {
    const shells = [
      shell(2001, { runtime: { status: "running" } }),
      shell(2002, { runtime: { status: "running" }, hasPendingApprovals: true }),
      shell(2003, { runtime: { status: "running" }, hasPendingUserInput: true }),
      shell(2004, { runtime: { status: "failed" } }),
      shell(2005, { runtime: { status: "interrupted" } }),
      shell(2006, { runtime: { status: "idle" } }),
      { id: "t-free", title: "Freier Chat", runtime: { status: "failed" } },
    ];
    const states = await ticketActivityStates(getFlightplanChat(), shells, lookup);
    expect(states.map((s) => [s.ticket, s.threadId, s.state])).toEqual([
      [2001, "t-2001", "working"],
      [2002, "t-2002", "approval"],
      [2003, "t-2003", "input"],
      [2004, "t-2004", "error"],
    ]);
    // An interrupted run leaves no entry.
    expect(states.some((s) => s.ticket === 2005)).toBe(false);
    // tickets keeps the old meaning: working only.
    expect(await workingTickets(getFlightplanChat(), shells, lookup)).toEqual([2001]);
  });

  it("ranks approval > input > error > working per ticket", () => {
    expect(
      shellActivityState({
        runtime: { status: "failed" },
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toBe("approval");
    expect(shellActivityState({ runtime: { status: "running" }, hasPendingUserInput: true })).toBe(
      "input",
    );
    expect(shellActivityState({ runtime: { status: "failed" } })).toBe("error");
    expect(shellActivityState({ runtime: null })).toBeNull();
  });

  it("keeps the highest-ranked thread when a ticket has two", async () => {
    const two = async () => ({ threadId: "a" });
    const shells = [
      { id: "a", title: "#2100 a", runtime: { status: "running" } },
      { id: "a", title: "#2100 a", runtime: { status: "running" }, hasPendingApprovals: true },
    ];
    expect(await ticketActivityStates(getFlightplanChat(), shells, two)).toEqual([
      { ticket: 2100, threadId: "a", state: "approval" },
    ]);
  });
});

describe("reportActivity v2 message", () => {
  const lookup = async (ticketId: number) => ({ threadId: `t-${ticketId}` });

  it("sends v, tickets and states and re-sends on a state change", async () => {
    captureFrameLayout(true, "?layout=full");
    const sent: unknown[] = [];
    const target = { postMessage: (m: unknown) => void sent.push(m) };
    const working = [{ id: "t-3001", title: "#3001 x", runtime: { status: "running" } }];
    const approval = [{ ...working[0]!, hasPendingApprovals: true }];
    await reportActivity(working, false, target, lookup);
    await reportActivity(working, false, target, lookup);
    expect(sent).toEqual([
      {
        type: "fp:activity",
        v: 2,
        tickets: [3001],
        states: [{ ticket: 3001, threadId: "t-3001", state: "working" }],
      },
    ]);
    await reportActivity(approval, false, target, lookup);
    expect(sent[1]).toEqual({
      type: "fp:activity",
      v: 2,
      tickets: [],
      states: [{ ticket: 3001, threadId: "t-3001", state: "approval" }],
    });
    await reportActivity(approval, true, target, lookup);
    expect(sent).toHaveLength(3);
  });
});
