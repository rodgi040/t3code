import { describe, expect, it } from "vite-plus/test";

import {
  flightplanEmbedOn,
  isEmbedLocation,
  setFlightplanEmbed,
  subscribeFlightplanEmbed,
  ticketIdFromEmbedPath,
} from "./embed";

describe("flightplan embed", () => {
  it("detects the embed route and the query flag", () => {
    expect(isEmbedLocation("/embed/1132", "")).toBe(true);
    expect(isEmbedLocation("/env/thread", "?embed=1")).toBe(true);
    expect(isEmbedLocation("/env/thread", "?embed=%221%22")).toBe(true);
    expect(isEmbedLocation("/", "")).toBe(false);
    expect(isEmbedLocation("/settings", "?embed=0")).toBe(false);
  });

  it("reads the ticket id from the embed path", () => {
    expect(ticketIdFromEmbedPath("/embed/1132")).toBe("1132");
    expect(ticketIdFromEmbedPath("/")).toBeNull();
  });

  it("notifies subscribers (ChatView hides the details card while the flag is on)", () => {
    let calls = 0;
    const off = subscribeFlightplanEmbed(() => calls++);
    setFlightplanEmbed(true);
    expect(flightplanEmbedOn()).toBe(true);
    setFlightplanEmbed(false);
    expect(flightplanEmbedOn()).toBe(false);
    off();
    expect(calls).toBe(2);
  });
});
