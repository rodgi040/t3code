import { describe, expect, it } from "vite-plus/test";

import { getFlightplanChat, shellIsWorking, workingTickets } from "./channel";

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
