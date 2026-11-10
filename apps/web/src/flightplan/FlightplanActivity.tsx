import { useEffect } from "react";

import { useThreadShells } from "../state/entities";
import { reportActivity } from "./channel";
import { flightplanFrameFull } from "./embed";

const REPEAT_MS = 30_000;

/**
 * Flightplan OP#1802: tells the dashboard which tickets have an agent turn in flight, for every thread and not only
 * the open one. Renders nothing; outside the dashboard frame it does nothing.
 */
export function FlightplanActivity() {
  const full = flightplanFrameFull();
  const shells = useThreadShells(full);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors agent activity to the OpenProject parent frame (fp:activity) and repeats it so a dashboard that missed one catches up
  useEffect(() => {
    if (!full) return;
    void reportActivity(shells);
    const timer = window.setInterval(() => void reportActivity(shells, true), REPEAT_MS);
    return () => window.clearInterval(timer);
  }, [full, shells]);

  return null;
}
