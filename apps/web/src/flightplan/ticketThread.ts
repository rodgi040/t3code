import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import type { AtomCommand, AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentAuthorizationError } from "@t3tools/contracts";

import { newMessageId, newThreadId } from "../lib/utils";
import type { threadEnvironment } from "../state/threads";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

export interface TicketThreadRecord {
  readonly threadId: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly created?: boolean;
}

type CommandRunner<C> =
  C extends AtomCommand<infer W, infer A, infer E>
    ? (value: W) => Promise<AtomCommandResult<A, E | EnvironmentAuthorizationError>>
    : never;

export interface TicketThreadCommands {
  readonly createThread: CommandRunner<typeof threadEnvironment.create>;
  readonly startTurn: CommandRunner<typeof threadEnvironment.startTurn>;
  /** Only used by fp:start to remove the empty thread of a lost claim race. */
  readonly deleteThread?: CommandRunner<typeof threadEnvironment.delete>;
}

/** fp:start lost the race: the server record already belongs to another thread (another tab was faster). */
export class TicketThreadClaimLostError extends Error {
  constructor(readonly threadId: string) {
    super("Das Ticket hat schon einen Thread.");
    this.name = "TicketThreadClaimLostError";
  }
}

/** Flightplan OP#1802: the first turn of a ticket's chat, sent when the dashboard opens or starts the ticket. */
export function ticketStartPrompt(ticketId: string): string {
  return [
    `Ticket #${ticketId} wurde im ADA-Dashboard geöffnet.`,
    "Fasse zuerst kurz den Stand zusammen: was erledigt ist, was offen ist.",
    "Nenne danach die offenen Entscheidungen (was, wo, wie) und stelle deine Fragen dazu direkt hier im Chat.",
    "Ändere dabei noch nichts, weder am Ticket noch am Code.",
  ].join("\n");
}

export function claudeSelection(project: Pick<EnvironmentProject, "defaultModelSelection">) {
  if (project.defaultModelSelection?.instanceId === "claudeAgent") {
    return project.defaultModelSelection;
  }
  return createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-5-5", [
    { id: "fastMode", value: false },
  ]);
}

export async function readTicketThread(ticketId: string): Promise<TicketThreadRecord | null> {
  const response = await fetch(`/api/flightplan/tickets/${ticketId}`, {
    credentials: "same-origin",
  });
  if (!response.ok) return null;
  return (await response.json()) as TicketThreadRecord | null;
}

/**
 * Flightplan OP#1802/OP#1840: creates a thread for a ticket, secures the ticket-to-thread record on the server and,
 * when `startAgent` is set and this call really created the record, sends the start turn. Does not navigate.
 */
export async function createTicketThread(input: {
  readonly ticketId: string;
  readonly project: EnvironmentProject;
  readonly commands: TicketThreadCommands;
  readonly replace?: string | null;
  readonly startAgent: boolean;
  /** fp:start: a failed start turn is an error. The embed route keeps ignoring it, as before OP#1840. */
  readonly strictStart?: boolean;
}): Promise<TicketThreadRecord> {
  const { ticketId, project, commands, replace, startAgent, strictStart } = input;
  const threadId = newThreadId();
  const modelSelection = claudeSelection(project);
  const created = await commands.createThread({
    environmentId: project.environmentId,
    input: {
      threadId,
      projectId: project.id,
      title: `Ticket #${ticketId}`,
      modelSelection,
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
  const record = (await put.json()) as TicketThreadRecord;
  if (strictStart && (!record.created || record.threadId !== threadId)) {
    // Our thread is an orphan now; delete it while it is still empty (best effort).
    await commands
      .deleteThread?.({
        environmentId: project.environmentId,
        input: { threadId, onlyIfUnused: true },
      })
      .catch(() => undefined);
    throw new TicketThreadClaimLostError(record.threadId);
  }
  // OP#1802: only the dashboard starts the agent, and only for the thread this call created.
  if (startAgent && record.created && record.threadId === threadId) {
    const started = await commands.startTurn({
      environmentId: project.environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: ticketStartPrompt(ticketId),
          attachments: [],
        },
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
    });
    if (strictStart && started._tag === "Failure")
      throw new Error("Start-Turn konnte nicht gesendet werden.");
  }
  return record;
}
