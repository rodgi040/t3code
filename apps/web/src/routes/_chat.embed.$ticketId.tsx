import { ProviderInstanceId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { bindTicketThread } from "../flightplan/channel";
import { flightplanFrameFull, isFullLayoutSearch, setFlightplanEmbed } from "../flightplan/embed";
import { newThreadId } from "../lib/utils";
import { Button } from "../components/ui/button";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

interface TicketThreadRecord {
  readonly threadId: string;
  readonly environmentId: string;
  readonly projectId: string;
}

const EMPTY_PROJECTS_TIMEOUT_MS = 8000;

export function embedNoProject(
  projects: readonly { readonly archivedAt?: unknown }[],
  waitedTooLong: boolean,
): boolean {
  return waitedTooLong && !projects.some((item) => item.archivedAt == null);
}

function claudeSelection(project: {
  readonly defaultModelSelection: { readonly instanceId: string } | null;
}) {
  if (project.defaultModelSelection?.instanceId === "claudeAgent") {
    return project.defaultModelSelection;
  }
  return createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-5-5", [
    { id: "fastMode", value: false },
  ]);
}

async function readTicketThread(ticketId: string): Promise<TicketThreadRecord | null> {
  const response = await fetch(`/api/flightplan/tickets/${ticketId}`, {
    credentials: "same-origin",
  });
  if (!response.ok) return null;
  return (await response.json()) as TicketThreadRecord | null;
}

function EmbedTicketRoute() {
  const { ticketId } = Route.useParams();
  const projects = useProjects();
  const navigate = useNavigate();
  // Flightplan OP#1778: the dashboard split opens the ticket's thread in the full layout (sidebar, header).
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  // OP#1784: the ticket's thread was deleted in T3; the user decides whether a new one replaces it.
  const [missing, setMissing] = useState<string | null>(null);
  const [replace, setReplace] = useState<string | null>(null);
  const shells = useThreadShells();
  const shellsReady = useAllEnvironmentShellsBootstrapped();

  const fullLayout = flightplanFrameFull() || isFullLayoutSearch(searchStr);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the embed registry on while this route is mounted
  useEffect(() => {
    if (fullLayout) return;
    setFlightplanEmbed(true);
    return () => setFlightplanEmbed(false);
  }, [fullLayout]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- flags a project list that stays empty
  useEffect(() => {
    const timer = window.setTimeout(() => setWaitedTooLong(true), EMPTY_PROJECTS_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- claims this ticket's thread on the server and moves the router onto it
  useEffect(() => {
    const project = projects.find((item) => item.archivedAt == null);
    if (!project || !shellsReady || missing || started.current) return;
    started.current = true;
    void (async () => {
      let record = replace ? null : await readTicketThread(ticketId);
      if (record && !shells.some((shell) => shell.id === record?.threadId)) {
        started.current = false;
        setMissing(record.threadId);
        return;
      }
      if (!record) {
        const threadId = newThreadId();
        const created = await createThread({
          environmentId: project.environmentId,
          input: {
            threadId,
            projectId: project.id,
            title: `Ticket #${ticketId}`,
            modelSelection: claudeSelection(project),
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: new Date().toISOString(),
          },
        });
        if (created._tag === "Failure") {
          throw new Error("Thread konnte nicht angelegt werden.");
        }
        const put = await fetch(`/api/flightplan/tickets/${ticketId}`, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            threadId,
            environmentId: project.environmentId,
            projectId: project.id,
            ...(replace ? { replaces: replace } : {}),
          }),
        });
        if (!put.ok) throw new Error(`Thread-Zuordnung ${put.status}`);
        record = (await put.json()) as TicketThreadRecord;
      }
      if (fullLayout) bindTicketThread(Number(ticketId), record.threadId);
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: record.environmentId as EnvironmentId,
          threadId: record.threadId as ThreadId,
        },
        search: fullLayout ? { embed: undefined } : { embed: "1" },
        replace: true,
      });
    })().catch((cause: unknown) => {
      started.current = false;
      setError(cause instanceof Error ? cause.message : "Chat konnte nicht geöffnet werden.");
    });
  }, [
    createThread,
    fullLayout,
    missing,
    navigate,
    projects,
    replace,
    shells,
    shellsReady,
    ticketId,
  ]);

  if (error) return <p data-fp-embed-error="true">{error}</p>;
  if (missing) {
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-sm" data-fp-embed-missing={ticketId}>
        <p>Der Chat zu #{ticketId} wurde in T3 gelöscht.</p>
        <Button
          size="sm"
          onClick={() => {
            setReplace(missing);
            setMissing(null);
          }}
        >
          Neuen Chat für #{ticketId} anlegen
        </Button>
      </div>
    );
  }
  if (embedNoProject(projects, waitedTooLong)) {
    return (
      <p data-fp-embed-error="true">
        Kein Projekt in T3 – volle Ansicht öffnen: <a href="/chat/">/chat/</a>
      </p>
    );
  }
  return <p data-fp-embed-pending="true">Öffne Chat zu #{ticketId} …</p>;
}

export const Route = createFileRoute("/_chat/embed/$ticketId")({
  component: EmbedTicketRoute,
});
