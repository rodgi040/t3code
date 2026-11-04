import { describe, expect, it } from "vite-plus/test";

import { embedNoProject } from "../routes/_chat.embed.$ticketId";

describe("embed empty project state", () => {
  it("shows the error only after the timeout with no active project", () => {
    expect(embedNoProject([], false)).toBe(false);
    expect(embedNoProject([], true)).toBe(true);
    expect(embedNoProject([{ archivedAt: "x" }], true)).toBe(true);
    expect(embedNoProject([{ archivedAt: null }], true)).toBe(false);
  });
});
