let embedOn = false;
const listeners = new Set<() => void>();

export function isEmbedLocation(pathname: string, search: string): boolean {
  if (pathname === "/embed" || pathname.startsWith("/embed/")) return true;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const value = params.get("embed");
  // TanStack writes the string as JSON, so the raw query is embed=%221%22.
  return value === "1" || value === '"1"';
}

export function ticketIdFromEmbedPath(pathname: string): string | null {
  const match = pathname.match(/\/embed\/(\d+)\/?$/);
  return match?.[1] ?? null;
}

export function setFlightplanEmbed(on: boolean): void {
  embedOn = on;
  if (typeof document !== "undefined") {
    if (on) document.documentElement.dataset.fpEmbed = "1";
    else delete document.documentElement.dataset.fpEmbed;
  }
  for (const listener of listeners) listener();
}

export function flightplanEmbedOn(): boolean {
  return embedOn;
}

export function subscribeFlightplanEmbed(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
