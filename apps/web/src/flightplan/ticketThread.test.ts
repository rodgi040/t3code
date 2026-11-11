import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  TICKET_RUNTIME_MODE,
  createTicketThread,
  sendTicketStart,
  ticketAwaitsStart,
  ticketStartPrompt,
  type TicketThreadCommands,
} from "./ticketThread";

const project = {
  environmentId: "env-1",
  id: "project-1",
  defaultModelSelection: null,
} as never;

function commands() {
  return {
    createThread: vi.fn(async () => ({ _tag: "Success" })),
    startTurn: vi.fn(async () => ({ _tag: "Success" })),
  } as unknown as TicketThreadCommands & {
    createThread: ReturnType<typeof vi.fn>;
    startTurn: ReturnType<typeof vi.fn>;
  };
}

function mockServer() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { threadId: string };
      return { ok: true, status: 200, json: async () => ({ ...body, created: true }) };
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("ticket thread creation (OP#1840, OP#1841)", () => {
  it("opening creates the thread in auto mode and sends no turn", async () => {
    mockServer();
    const cmd = commands();
    await createTicketThread({ ticketId: "1840", project, commands: cmd, startAgent: false });
    expect(cmd.createThread).toHaveBeenCalledOnce();
    expect(cmd.createThread.mock.calls[0]?.[0].input.runtimeMode).toBe("auto");
    expect(TICKET_RUNTIME_MODE).toBe("auto");
    expect(cmd.startTurn).not.toHaveBeenCalled();
  });

  it("fp:start path still sends exactly one start turn, in auto mode", async () => {
    mockServer();
    const cmd = commands();
    await createTicketThread({
      ticketId: "1840",
      project,
      commands: cmd,
      startAgent: true,
      strictStart: true,
    });
    expect(cmd.startTurn).toHaveBeenCalledOnce();
    const input = cmd.startTurn.mock.calls[0]?.[0].input;
    expect(input.runtimeMode).toBe("auto");
    expect(input.message.text).toBe(ticketStartPrompt("1840"));
  });
});

describe("Zusammenfassung holen (OP#1840)", () => {
  const shell = {
    environmentId: "env-1",
    id: "thread-1",
    modelSelection: { instanceId: "claudeAgent", model: "m" },
    runtimeMode: "auto",
    interactionMode: "default",
  } as never;

  it("is offered only while the thread has no turn", () => {
    expect(ticketAwaitsStart({ latestUserMessageAt: null, latestRun: null })).toBe(true);
    expect(
      ticketAwaitsStart({ latestUserMessageAt: "2026-11-11T10:00:00Z", latestRun: null }),
    ).toBe(false);
    expect(ticketAwaitsStart({ latestUserMessageAt: null, latestRun: {} as never })).toBe(false);
    expect(ticketAwaitsStart(null)).toBe(false);
  });

  it("sends exactly one start turn and ignores a second click while sending", async () => {
    let release: () => void = () => undefined;
    const startTurn = vi.fn(
      () => new Promise((resolve) => (release = () => resolve({ _tag: "Success" }))),
    ) as never as TicketThreadCommands["startTurn"] & ReturnType<typeof vi.fn>;
    const busy = { current: false };
    const first = sendTicketStart({ ticketId: "1840", shell, startTurn, busy });
    const second = await sendTicketStart({ ticketId: "1840", shell, startTurn, busy });
    expect(second).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(startTurn).toHaveBeenCalledOnce();
    expect(busy.current).toBe(false);
  });
});
