let embedOn = false;
const listeners = new Set<() => void>();

function searchFlag(search: string, name: string): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const value = params.get(name);
  // TanStack writes strings as JSON, so the raw query may be name=%22value%22.
  return value === null ? null : value.replace(/^"(.*)"$/, "$1");
}

/**
 * Flightplan OP#1778: `?layout=full` asks for the full T3 layout inside the frame (thread sidebar, header), used by
 * the dashboard split. Without it, `/embed/<id>` and `?embed=1` keep the compact embed of the workplace page.
 */
export function isFullLayoutSearch(search: string): boolean {
  return searchFlag(search, "layout") === "full";
}

export function isEmbedLocation(pathname: string, search: string): boolean {
  if (isFullLayoutSearch(search)) return false;
  if (pathname === "/embed" || pathname.startsWith("/embed/")) return true;
  return searchFlag(search, "embed") === "1";
}

export function ticketIdFromEmbedPath(pathname: string): string | null {
  const match = pathname.match(/\/embed\/(\d+)\/?$/);
  return match?.[1] ?? null;
}

export function setFlightplanEmbed(on: boolean): void {
  embedOn = on;
  for (const listener of listeners) listener();
}

export function flightplanEmbedOn(): boolean {
  return embedOn;
}

export function subscribeFlightplanEmbed(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Flightplan OP#1778: decided once per page load from the URL the parent framed. The router may drop the query on its
// first navigation, so the channel captures it before the app starts (installFlightplanChannel).
let frameFull: boolean | null = null;

export function captureFrameLayout(
  framed: boolean = typeof window !== "undefined" && window.parent !== window,
  search: string = typeof window !== "undefined" ? window.location.search : "",
): boolean {
  frameFull = framed && isFullLayoutSearch(search);
  return frameFull;
}

export function flightplanFrameFull(): boolean {
  return frameFull ?? captureFrameLayout();
}

/** The thread sidebar turns into a sheet below this width; in the split frame it stays from 600 px on. */
export function sidebarMobileQuery(): string {
  return flightplanFrameFull() ? "(max-width: 599px)" : "(max-width: 767px)";
}
