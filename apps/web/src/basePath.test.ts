import { afterEach, describe, expect, it, vi } from "vite-plus/test";

async function load(base: string) {
  vi.resetModules();
  vi.stubEnv("BASE_URL", base);
  return import("./basePath");
}

afterEach(() => vi.unstubAllEnvs());

describe("basePath", () => {
  it("leaves URLs alone for the root build", async () => {
    const { BASE_PATH, withBasePath } = await load("/");
    expect(BASE_PATH).toBe("");
    expect(withBasePath("/api/auth/session")).toBe("/api/auth/session");
  });

  it("prefixes root-absolute paths and same-origin URLs once", async () => {
    const { BASE_PATH, withBasePath } = await load("/chat/");
    expect(BASE_PATH).toBe("/chat");
    const origin = "http://op.test:8090";
    expect(withBasePath("/api/x?a=1#h", origin)).toBe("/chat/api/x?a=1#h");
    expect(withBasePath("/chat/api/x", origin)).toBe("/chat/api/x");
    expect(withBasePath("http://op.test:8090/ws", origin)).toBe("http://op.test:8090/chat/ws");
    expect(withBasePath("ws://op.test:8090/ws", origin)).toBe("ws://op.test:8090/chat/ws");
  });

  it("keeps the OpenProject API unprefixed", async () => {
    const { withBasePath } = await load("/chat");
    const origin = "http://op.test:8090";
    expect(withBasePath("/api/v3/work_packages?x=1", origin)).toBe("/api/v3/work_packages?x=1");
    expect(withBasePath("http://op.test:8090/api/v3/projects", origin)).toBe(
      "http://op.test:8090/api/v3/projects",
    );
    expect(withBasePath("/api/auth/session", origin)).toBe("/chat/api/auth/session");
  });

  it("does not touch other origins, relative paths, or protocol-relative URLs", async () => {
    const { withBasePath } = await load("/chat");
    const origin = "http://op.test:8090";
    expect(withBasePath("https://example.com/api", origin)).toBe("https://example.com/api");
    expect(withBasePath("assets/a.js", origin)).toBe("assets/a.js");
    expect(withBasePath("//example.com/x", origin)).toBe("//example.com/x");
    expect(withBasePath("data:text/plain,hi", origin)).toBe("data:text/plain,hi");
  });
});
