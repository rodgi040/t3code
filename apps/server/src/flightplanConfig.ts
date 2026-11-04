/**
 * Fork (flightplan): environment switches for running behind OpenProject. All default to upstream behavior
 * except the own-origin check for cookie-authenticated WebSockets.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export type DisableableSurface = "guest" | "mcp" | "oauth";

const SURFACE_PREFIXES: Record<DisableableSurface, ReadonlyArray<string>> = {
  guest: ["/api/guest"],
  mcp: ["/mcp"],
  oauth: [
    "/oauth",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
  ],
};

const optional = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map((option) => Option.getOrUndefined(option)?.trim() ?? ""),
  );

const splitList = (raw: string) =>
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const normalizeBasePath = (raw: string): string => {
  const trimmed = raw.replace(/^\/+|\/+$/g, "");
  return trimmed.length === 0 ? "" : `/${trimmed}`;
};

export const flightplanConfig = Effect.gen(function* () {
  const basePath = normalizeBasePath(yield* optional("T3CODE_BASE_PATH"));
  const allowedOrigins = splitList(yield* optional("T3CODE_ALLOWED_ORIGINS")).map((origin) =>
    origin.replace(/\/+$/, "").toLowerCase(),
  );
  const disabled = new Set(
    splitList(yield* optional("T3CODE_DISABLE_SURFACES")).map((entry) => entry.toLowerCase()),
  );
  const suppressStartupPairing = ["1", "true"].includes(
    (yield* optional("T3CODE_SUPPRESS_STARTUP_PAIRING")).toLowerCase(),
  );
  const disabledPrefixes = (Object.keys(SURFACE_PREFIXES) as Array<DisableableSurface>)
    .filter((surface) => disabled.has(surface))
    .flatMap((surface) => SURFACE_PREFIXES[surface]);
  return { basePath, allowedOrigins, disabledPrefixes, suppressStartupPairing };
});

/**
 * Canonical form used to match disabled routes: percent-decoded (repeatedly), duplicate slashes
 * collapsed, dot segments resolved, lower-cased. "/chat//mcp", "/%6dcp" and "/MCP" all become "/mcp".
 */
export const canonicalRequestPath = (url: string): string => {
  let path = url.split(/[?#]/, 1)[0] ?? "";
  for (let round = 0; round < 3; round++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      break;
    }
    if (decoded === path) break;
    path = decoded;
  }
  const segments: Array<string> = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment.toLowerCase());
  }
  return `/${segments.join("/")}`;
};

export const isDisabledPath = (url: string, disabledPrefixes: ReadonlyArray<string>): boolean => {
  const path = canonicalRequestPath(url);
  return disabledPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
};

/** Cookie-authenticated WebSocket upgrades must come from the own origin or a configured one. */
export const isOriginAllowed = (input: {
  readonly origin: string | undefined;
  readonly host: string | undefined;
  readonly allowedOrigins: ReadonlyArray<string>;
}): boolean => {
  if (input.origin === undefined || input.origin.length === 0) return false;
  const origin = input.origin.replace(/\/+$/, "").toLowerCase();
  if (input.allowedOrigins.length > 0) return input.allowedOrigins.includes(origin);
  try {
    return input.host !== undefined && new URL(origin).host === input.host.toLowerCase();
  } catch {
    return false;
  }
};

/** HTTPS directly or behind a proxy that says so. */
export const isSecureRequest = (input: {
  readonly forwardedProto: string | undefined;
  readonly url: string;
}): boolean =>
  input.forwardedProto?.split(",")[0]?.trim().toLowerCase() === "https" ||
  input.url.startsWith("https:");

/** "/chat/pair" when the URL or T3CODE_BASE_PATH carries a prefix, else "/pair". */
export const pairPathFor = (baseUrl: URL, envBasePath: string | undefined): string => {
  const fromUrl = normalizeBasePath(baseUrl.pathname);
  return `${fromUrl === "" ? normalizeBasePath(envBasePath ?? "") : fromUrl}/pair`;
};

/**
 * Ticket-thread endpoint gate. PUT needs an allowed Origin. GET may omit it (browsers send no Origin on
 * same-origin GET) but then Sec-Fetch-Site must be same-origin or absent; a present Origin must be allowed.
 */
export const isTicketRequestAllowed = (input: {
  readonly method: string;
  readonly origin: string | undefined;
  readonly host: string | undefined;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly secFetchSite: string | undefined;
}): boolean => {
  const hasOrigin = input.origin !== undefined && input.origin.length > 0;
  if (hasOrigin || input.method !== "GET") return isOriginAllowed(input);
  return input.secFetchSite === undefined || input.secFetchSite.toLowerCase() === "same-origin";
};
