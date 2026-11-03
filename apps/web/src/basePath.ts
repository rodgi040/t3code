/**
 * Fork: run under a path prefix such as "/chat" behind a proxy that strips it. Vite `base` prefixes
 * assets; the shim below prefixes same-origin runtime URLs. Base "/" installs nothing.
 */

function normalizeBasePath(base: string): string {
  const trimmed = base.trim().replace(/^\/+|\/+$/g, "");
  return trimmed.length === 0 ? "" : `/${trimmed}`;
}

/** "" for the root build, otherwise "/chat" style (leading slash, no trailing slash). */
export const BASE_PATH: string = normalizeBasePath(import.meta.env.BASE_URL ?? "/");

/**
 * Same-origin paths that must stay unprefixed, for example OpenProject's API (`/api/v3/`).
 * Build-time list, comma separated: VITE_T3CODE_BASE_PATH_EXCLUDE (default "/api/v3/").
 */
const EXCLUDED_PREFIXES: ReadonlyArray<string> = (
  import.meta.env.VITE_T3CODE_BASE_PATH_EXCLUDE ?? "/api/v3/"
)
  .split(",")
  .map((entry: string) => entry.trim())
  .filter((entry: string) => entry.startsWith("/"));

function isExcluded(pathname: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function hasPrefix(pathname: string): boolean {
  return pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`);
}

/** Prefix a root-absolute path ("/api/x") or a same-origin absolute URL; leave everything else. */
export function withBasePath(
  input: string,
  origin: string = globalThis.location?.origin ?? "http://localhost",
): string {
  if (BASE_PATH === "") return input;
  if (input.startsWith("/") && !input.startsWith("//")) {
    const path = input.split(/[?#]/, 1)[0] ?? input;
    return hasPrefix(path) || isExcluded(path) ? input : `${BASE_PATH}${input}`;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }
  const sameHost = url.host === new URL(origin).host;
  const knownScheme = /^(https?|wss?):$/.test(url.protocol);
  if (!sameHost || !knownScheme || hasPrefix(url.pathname) || isExcluded(url.pathname))
    return input;
  url.pathname = `${BASE_PATH}${url.pathname}`;
  return url.toString();
}

function rewriteUrlLike(value: string | URL): string | URL {
  return typeof value === "string" ? withBasePath(value) : new URL(withBasePath(value.toString()));
}

let installed = false;

export function installBasePathShim(): void {
  if (installed || BASE_PATH === "" || typeof window === "undefined") return;
  installed = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" || input instanceof URL) {
      return nativeFetch(rewriteUrlLike(input), init);
    }
    const rewritten = withBasePath(input.url);
    return nativeFetch(rewritten === input.url ? input : new Request(rewritten, input), init);
  };

  const NativeWebSocket = window.WebSocket;
  class PrefixedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(rewriteUrlLike(url), protocols);
    }
  }
  window.WebSocket = PrefixedWebSocket;

  const NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    class PrefixedEventSource extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(rewriteUrlLike(url), init);
      }
    }
    window.EventSource = PrefixedEventSource;
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: [boolean?, (string | null)?, (string | null)?]
  ) {
    return (nativeOpen as (...args: unknown[]) => void).call(
      this,
      method,
      rewriteUrlLike(url),
      ...rest,
    );
  } as typeof XMLHttpRequest.prototype.open;
}

installBasePathShim();
