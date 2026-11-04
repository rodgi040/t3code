import { ProviderInstanceId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { setFlightplanEmbed } from "../flightplan/embed";
import { newThreadId } from "../lib/utils";
import { useProjects } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

interface TicketThreadRecord {
  readonly threadId: string;
  readonly environmentId: string;
  readonly projectId: string;
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
  return (await response.json()) as TicketThreadRecord;
}

function EmbedTicketRoute() {
  const { ticketId } = Route.useParams();
  const projects = useProjects();
  const navigate = useNavigate();
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the embed registry on while this route is mounted
  useEffect(() => {
    setFlightplanEmbed(true);
    return () => setFlightplanEmbed(false);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- claims this ticket's thread on the server and moves the router onto it
  useEffect(() => {
    const project = projects.find((item) => item.archivedAt == null);
    if (!project || started.current) return;
    started.current = true;
    void (async () => {
      let record = await readTicketThread(ticketId);
      if (!record) {
        const threadId = newThreadId();
        const created = await createThread({
          environmentId: project.environmentId,
          input: {
            threadId,
            projectId: project.id,
            title: `Ticket #${ticketId}`,
            modelSelection: claudeSelection(project),
            runtimeMode: "full-access",
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
          }),
        });
        if (!put.ok) throw new Error(`Thread-Zuordnung ${put.status}`);
        record = (await put.json()) as TicketThreadRecord;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: record.environmentId as EnvironmentId,
          threadId: record.threadId as ThreadId,
        },
        search: { embed: "1" },
        replace: true,
      });
    })().catch((cause: unknown) => {
      started.current = false;
      setError(cause instanceof Error ? cause.message : "Chat konnte nicht geöffnet werden.");
    });
  }, [createThread, navigate, projects, ticketId]);

  if (error) return <p data-fp-embed-error="true">{error}</p>;
  return <p data-fp-embed-pending="true">Öffne den Chat…</p>;
}

export const Route = createFileRoute("/_chat/embed/$ticketId")({
  component: EmbedTicketRoute,
});
