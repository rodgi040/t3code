import { BASE_PATH } from "./basePath";

/** The page a guest link opens. It shows one shared thread to a browser with no T3 session. */
export const GUEST_PAGE_PATH = "/guest";

export function isGuestPage(): boolean {
  return window.location.pathname === `${BASE_PATH}${GUEST_PAGE_PATH}`;
}
