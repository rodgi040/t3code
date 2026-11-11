import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { RuntimeRequestId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { newMessageId } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { environmentThreadDetails, threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import {
  reportActivity,
  retryPendingForwards,
  setTicketTurnHost,
  type TicketTurnHost,
} from "./channel";
import { flightplanFrameFull } from "./embed";
import { refreshRequestWatches, setTicketRequestsHost, type TicketRequestsHost } from "./requests";
import { createTicketThread, ticketWorkPrompt } from "./ticketThread";

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
  const shellsReady = useAllEnvironmentShellsBootstrapped();
  const deleteThread = useOrchestrationCommand(threadEnvironment.delete, { reportFailure: false });
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const latest = useRef({
    shells,
    projects,
    createThread,
    startTurn,
    deleteThread,
    shellsReady,
    respondToApproval,
    respondToUserInput,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the registered host reads the newest shells, projects and commands without re-registering
  useEffect(() => {
    latest.current = {
      shells,
      projects,
      createThread,
      startTurn,
      deleteThread,
      shellsReady,
      respondToApproval,
      respondToUserInput,
    };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors agent activity to the OpenProject parent frame (fp:activity) and repeats it so a dashboard that missed one catches up
  useEffect(() => {
    if (!full) return;
    void reportActivity(shells);
    // OP#1840: the same beat retries answers and assumption notes that could not be sent yet.
    if (shellsReady) void retryPendingForwards();
    // OP#1842: tickets the dashboard asked requests for get fp:requests again when theirs change.
    void refreshRequestWatches();
    const timer = window.setInterval(() => {
      void reportActivity(shells, true);
      if (shellsReady) void retryPendingForwards();
      void refreshRequestWatches({ recheck: true });
    }, REPEAT_MS);
    return () => window.clearInterval(timer);
  }, [full, shells, shellsReady]);

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
          // OP#1840: behind a running turn the text is queued, never steered into it.
          dispatchMode: "queue",
        },
      });
      return result._tag !== "Failure";
    };
    const host: TicketTurnHost = {
      ready: () => latest.current.shellsReady,
      shells: () => latest.current.shells,
      sendTurn,
      startExisting: (threadId, ticket) => sendTurn(threadId, ticketWorkPrompt(String(ticket))),
      startNew: async (ticket) => {
        const {
          projects: all,
          createThread: create,
          startTurn: run,
          deleteThread: remove,
        } = latest.current;
        const project = all.find((item) => item.archivedAt == null);
        if (!project) throw new Error("Kein Projekt in T3.");
        const record = await createTicketThread({
          ticketId: String(ticket),
          project,
          commands: { createThread: create, startTurn: run, deleteThread: remove },
          startAgent: true,
          strictStart: true,
        });
        return record.threadId;
      },
    };
    setTicketTurnHost(host);
    void retryPendingForwards();
    return () => setTicketTurnHost(null);
  }, [full]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the request host (fp:requests-get, fp:respond) of the channel while this frame is the dashboard split
  useEffect(() => {
    if (!full) return;
    const find = (threadId: string) => latest.current.shells.find((item) => item.id === threadId);
    const host: TicketRequestsHost = {
      ready: () => latest.current.shellsReady,
      shells: () => latest.current.shells,
      // Only the asked ticket's thread is subscribed, and only while it waits for the human (see refreshRequestWatches).
      watch: (threadId, onChange) => {
        const shell = find(threadId);
        if (!shell) return null;
        return appAtomRegistry.subscribe(
          environmentThreadDetails.quietThreadAtom({
            environmentId: shell.environmentId,
            threadId: shell.id,
          }),
          (structure) =>
            onChange(structure === null ? null : derivePendingThreadRequests(structure.projection)),
          { immediate: true },
        );
      },
      respondApproval: async (threadId, requestId, decision) => {
        const shell = find(threadId);
        if (!shell) return false;
        const result = await latest.current.respondToApproval({
          environmentId: shell.environmentId,
          input: { threadId: shell.id, requestId: RuntimeRequestId.make(requestId), decision },
        });
        return result._tag !== "Failure";
      },
      respondUserInput: async (threadId, requestId, answers) => {
        const shell = find(threadId);
        if (!shell) return false;
        const result = await latest.current.respondToUserInput({
          environmentId: shell.environmentId,
          input: { threadId: shell.id, requestId: RuntimeRequestId.make(requestId), answers },
        });
        return result._tag !== "Failure";
      },
    };
    setTicketRequestsHost(host);
    return () => setTicketRequestsHost(null);
  }, [full]);

  return null;
}
