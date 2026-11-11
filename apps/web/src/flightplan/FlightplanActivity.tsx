import { useEffect, useRef } from "react";

import { newMessageId } from "../lib/utils";
import { useProjects, useThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { reportActivity, setTicketTurnHost, type TicketTurnHost } from "./channel";
import { flightplanFrameFull } from "./embed";
import { createTicketThread, ticketStartPrompt } from "./ticketThread";

const REPEAT_MS = 30_000;

/**
 * Flightplan OP#1802: tells the dashboard which tickets have an agent turn in flight, for every thread and not only
 * the open one. Flightplan OP#1840: also gives the channel the means to start and continue ticket threads in the
 * background (fp:start, fp:answered, fp:assumption). Renders nothing; outside the dashboard frame it does nothing.
 */
export function FlightplanActivity() {
  const full = flightplanFrameFull();
  const shells = useThreadShells(full);
  const projects = useProjects();
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const latest = useRef({ shells, projects, createThread, startTurn });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the registered host reads the newest shells, projects and commands without re-registering
  useEffect(() => {
    latest.current = { shells, projects, createThread, startTurn };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors agent activity to the OpenProject parent frame (fp:activity) and repeats it so a dashboard that missed one catches up
  useEffect(() => {
    if (!full) return;
    void reportActivity(shells);
    const timer = window.setInterval(() => void reportActivity(shells, true), REPEAT_MS);
    return () => window.clearInterval(timer);
  }, [full, shells]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the background turn host of the channel while this frame is the dashboard split
  useEffect(() => {
    if (!full) return;
    const sendTurn = async (threadId: string, text: string): Promise<boolean> => {
      const { shells: current, startTurn: run } = latest.current;
      const shell = current.find((item) => item.id === threadId);
      if (!shell) return false;
      const result = await run({
        environmentId: shell.environmentId,
        input: {
          threadId: shell.id,
          message: { messageId: newMessageId(), role: "user", text, attachments: [] },
          modelSelection: shell.modelSelection,
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
        },
      });
      return result._tag !== "Failure";
    };
    const host: TicketTurnHost = {
      shells: () => latest.current.shells,
      sendTurn,
      startExisting: (threadId, ticket) => sendTurn(threadId, ticketStartPrompt(String(ticket))),
      startNew: async (ticket) => {
        const { projects: all, createThread: create, startTurn: run } = latest.current;
        const project = all.find((item) => item.archivedAt == null);
        if (!project) throw new Error("Kein Projekt in T3.");
        const record = await createTicketThread({
          ticketId: String(ticket),
          project,
          commands: { createThread: create, startTurn: run },
          startAgent: true,
          strictStart: true,
        });
        return record.threadId;
      },
    };
    setTicketTurnHost(host);
    return () => setTicketTurnHost(null);
  }, [full]);

  return null;
}
