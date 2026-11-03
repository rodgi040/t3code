import { describe, expect, it } from "vite-plus/test";

import {
  canonicalRequestPath,
  isDisabledPath,
  isOriginAllowed,
  isSecureRequest,
  pairPathFor,
} from "./flightplanConfig.ts";

describe("canonicalRequestPath", () => {
  it("folds the known bypasses onto /mcp", () => {
    for (const url of [
      "//mcp",
      "/%6dcp",
      "/MCP",
      "/%2e/mcp",
      "/a/../mcp",
      "/mcp/",
      "//%256dcp?x=1",
    ]) {
      expect(canonicalRequestPath(url)).toBe("/mcp");
    }
  });
});

describe("isDisabledPath", () => {
  const prefixes = ["/api/guest", "/mcp", "/oauth", "/.well-known/oauth-protected-resource"];
  it("matches the surface and its children only", () => {
    expect(isDisabledPath("/mcp", prefixes)).toBe(true);
    expect(isDisabledPath("/OAuth/token", prefixes)).toBe(true);
    expect(isDisabledPath("/.well-known/oauth-protected-resource/mcp", prefixes)).toBe(true);
    expect(isDisabledPath("/api/guest/x", prefixes)).toBe(true);
    expect(isDisabledPath("/mcpx", prefixes)).toBe(false);
    expect(isDisabledPath("/api/auth/session", prefixes)).toBe(false);
    expect(isDisabledPath("/mcp", [])).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  it("defaults to the own origin (Host header)", () => {
    const base = { host: "localhost:8090", allowedOrigins: [] };
    expect(isOriginAllowed({ ...base, origin: "http://localhost:8090" })).toBe(true);
    expect(isOriginAllowed({ ...base, origin: "https://evil.example" })).toBe(false);
    expect(isOriginAllowed({ ...base, origin: undefined })).toBe(false);
  });

  it("uses only the configured origins when set", () => {
    const base = { host: "127.0.0.1:3774", allowedOrigins: ["http://localhost:8090"] };
    expect(isOriginAllowed({ ...base, origin: "http://localhost:8090/" })).toBe(true);
    expect(isOriginAllowed({ ...base, origin: "http://127.0.0.1:3774" })).toBe(false);
  });
});

describe("isSecureRequest", () => {
  it("honors X-Forwarded-Proto", () => {
    expect(isSecureRequest({ forwardedProto: "https", url: "/x" })).toBe(true);
    expect(isSecureRequest({ forwardedProto: "https, http", url: "/x" })).toBe(true);
    expect(isSecureRequest({ forwardedProto: "http", url: "/x" })).toBe(false);
    expect(isSecureRequest({ forwardedProto: undefined, url: "/x" })).toBe(false);
  });
});

describe("pairPathFor", () => {
  it("adds the prefix from the URL or the environment", () => {
    expect(pairPathFor(new URL("http://h:1"), undefined)).toBe("/pair");
    expect(pairPathFor(new URL("http://h:1"), "/chat/")).toBe("/chat/pair");
    expect(pairPathFor(new URL("http://h:1/chat/"), undefined)).toBe("/chat/pair");
  });
});
