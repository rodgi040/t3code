import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PARENT_ORIGIN, applyParentMessage, acceptParentSource } from "./channel";
import {
  handleRequestsGet,
  handleRespond,
  isRecommendedLabel,
  parseRespond,
  refreshRequestWatches,
  requestItems,
  resetTicketRequests,
  setTicketRequestsHost,
  type PendingSnapshot,
  type TicketRequestsHost,
} from "./requests";

type Shell = {
  id: string;
  title: string;
  runtime: { status: string };
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
};

function userInput(
  requestId: string,
  options: Array<{ label: string; value?: string }> = [
    { label: "Ja (Recommended)" },
    { label: "Nein" },
  ],
  extra: Record<string, unknown> = {},
) {
  return {
    requestId,
    createdAt: "2026-11-11T10:00:00.000Z",
    responseCapability: "live",
    dismissible: false,
    questions: [
      {
        id: "q1",
        header: "H",
        question: "Weiter?",
        multiSelect: false,
        options: options.map((o) => ({ description: "d", ...o })),
        ...extra,
      },
    ],
  };
}

function approval(requestId: string, extra: Record<string, unknown> = {}) {
  return {
    requestId,
    requestKind: "command",
    createdAt: "2026-11-11T10:01:00.000Z",
    detail: "rm -rf build/",
    reason: "Aufräumen",
    responseCapability: "live",
    ...extra,
  };
}

function pendingOf(
  userInputs: unknown[] = [],
  approvals: unknown[] = [],
  commands: string[] = ["rm -rf build/"],
): PendingSnapshot {
  return { userInputs, approvals, commands: new Set(commands) } as unknown as PendingSnapshot;
}

function setup(
  shells: Shell[],
  pending: PendingSnapshot | null,
  records: Record<number, string> = {},
) {
  let push: ((p: PendingSnapshot | null) => void) | null = null;
  const release = vi.fn();
  const host = {
    ready: () => true,
    shells: () => shells,
    watch: vi.fn((_thread: string, cb: (p: PendingSnapshot | null) => void) => {
      push = cb;
      cb(pending);
      return release;
    }),
    respondApproval: vi.fn(async () => true),
    respondUserInput: vi.fn(async () => true),
  } satisfies TicketRequestsHost;
  const target = { postMessage: vi.fn() };
  const lookup = vi.fn(async (ticket: number) =>
    records[ticket] ? { threadId: records[ticket] } : null,
  );
  const storage = (() => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  })();
  return {
    host,
    target,
    lookup,
    storage,
    release,
    push: (p: PendingSnapshot | null) => push?.(p),
  };
}

const sent = (target: { postMessage: ReturnType<typeof vi.fn> }) =>
  target.postMessage.mock.calls.map(([m]) => m);

const waiting = (id: string): Shell => ({
  id,
  title: "x",
  runtime: { status: "waiting" },
  hasPendingUserInput: true,
});

describe("fp:requests (OP#1842)", () => {
  beforeEach(() => resetTicketRequests());

  it("loads the requests of a thread that is not open and maps them", async () => {
    const s = setup([waiting("t1")], pendingOf([userInput("r1")], [approval("r2")]), { 12: "t1" });
    await handleRequestsGet(12, s);
    const [message] = sent(s.target);
    expect(message).toMatchObject({ type: "fp:requests", ticket: 12, threadId: "t1" });
    expect(message.items).toHaveLength(2);
    expect(message.items[0]).toMatchObject({
      requestId: "r1",
      kind: "question",
      answerable: true,
      question: {
        text: "Weiter?",
        multiSelect: false,
        options: [
          { label: "Ja (Recommended)", recommended: true },
          { label: "Nein", recommended: false },
        ],
      },
    });
    expect(message.items[1]).toMatchObject({
      kind: "approval",
      answerable: true,
      approval: { detail: "rm -rf build/", reason: "Aufräumen" },
    });
    expect(s.host.watch).toHaveBeenCalledWith("t1", expect.any(Function));
  });

  it("answers with empty items when no thread is assigned or nothing waits, without a subscription", async () => {
    const none = setup([], null, {});
    await handleRequestsGet(12, none);
    expect(sent(none.target)).toEqual([
      { type: "fp:requests", ticket: 12, threadId: null, items: [] },
    ]);
    const idle = setup([{ id: "t1", title: "x", runtime: { status: "idle" } }], null, { 13: "t1" });
    await handleRequestsGet(13, idle);
    expect(sent(idle.target)[0]).toMatchObject({ ticket: 13, items: [] });
    expect(idle.host.watch).not.toHaveBeenCalled();
  });

  it("marks several questions, multiSelect, not resumable and unreadable approvals as not answerable", () => {
    const two = userInput("a");
    two.questions.push({ ...two.questions[0]!, id: "q2" });
    const items = requestItems(
      pendingOf(
        [
          two,
          userInput("b", undefined, { multiSelect: true }),
          { ...userInput("c"), responseCapability: "not_resumable" },
        ],
        [
          approval("d", { detail: undefined }),
          approval("e", { responseCapability: "not_resumable" }),
        ],
      ),
    );
    expect(items.map((i) => [i.requestId, i.answerable])).toEqual([
      ["a", false],
      ["b", false],
      ["c", false],
      ["d", false],
      ["e", false],
    ]);
    expect(items.find((i) => i.requestId === "b")?.question?.multiSelect).toBe(true);
  });

  it("derives recommended from the label suffix only", () => {
    expect(isRecommendedLabel("Option A (Recommended)")).toBe(true);
    expect(isRecommendedLabel("Option A (Empfohlen) ")).toBe(true);
    expect(isRecommendedLabel("(Recommended) Option A")).toBe(false);
    expect(isRecommendedLabel("Option A")).toBe(false);
  });

  it("sends fp:requests again when the requests of a queried ticket change, and releases when nothing is open", async () => {
    const shells = [waiting("t1")];
    const s = setup(shells, pendingOf([userInput("r1")]), { 12: "t1" });
    await handleRequestsGet(12, s);
    s.push(pendingOf([userInput("r1")]));
    expect(sent(s.target)).toHaveLength(1); // unchanged: no repeat
    s.push(pendingOf([userInput("r1"), userInput("r3")]));
    expect(sent(s.target)).toHaveLength(2);
    expect(sent(s.target)[1].items).toHaveLength(2);
    shells[0] = { id: "t1", title: "x", runtime: { status: "idle" } };
    await refreshRequestWatches(s);
    expect(sent(s.target)[2]).toMatchObject({ ticket: 12, items: [] });
    expect(s.release).toHaveBeenCalled();
  });

  it("starts the subscription at the beat when the thread starts waiting after the query", async () => {
    const shells: Shell[] = [{ id: "t1", title: "x", runtime: { status: "idle" } }];
    const s = setup(shells, pendingOf([userInput("r1")]), { 12: "t1" });
    await handleRequestsGet(12, s);
    expect(s.host.watch).not.toHaveBeenCalled();
    shells[0] = waiting("t1");
    await refreshRequestWatches(s);
    expect(s.host.watch).toHaveBeenCalledTimes(1);
    expect(sent(s.target).at(-1).items).toHaveLength(1);
  });
});

describe("fp:respond (OP#1842)", () => {
  beforeEach(() => resetTicketRequests());
  const q = (extra: Record<string, unknown> = {}) => ({
    ticket: 12,
    threadId: "t1",
    requestId: "r1",
    kind: "question" as const,
    optionLabel: "Nein",
    text: null,
    ...extra,
  });
  const base = () =>
    setup([waiting("t1")], pendingOf([userInput("r1")], [approval("r2")]), { 12: "t1" });

  it("answers a question with an offered option over the explicit thread id", async () => {
    const s = base();
    await handleRespond(q(), s);
    expect(s.host.respondUserInput).toHaveBeenCalledWith("t1", "r1", { q1: "Nein" });
    expect(sent(s.target)).toEqual([
      { type: "fp:responded", ticket: 12, requestId: "r1", result: "ok" },
    ]);
  });

  it("uses the provider value of an option when it has one", async () => {
    const s = setup(
      [waiting("t1")],
      pendingOf([userInput("r1", [{ label: "Ja", value: "yes" }])]),
      { 12: "t1" },
    );
    await handleRespond(q({ optionLabel: "Ja" }), s);
    expect(s.host.respondUserInput).toHaveBeenCalledWith("t1", "r1", { q1: "yes" });
  });

  it("rejects an unknown option with error and sends nothing", async () => {
    const s = base();
    await handleRespond(q({ optionLabel: "Vielleicht" }), s);
    expect(s.host.respondUserInput).not.toHaveBeenCalled();
    expect(sent(s.target)[0]).toMatchObject({ result: "error" });
    // not consumed: a valid retry works
    await handleRespond(q(), s);
    expect(sent(s.target)[1]).toMatchObject({ result: "ok" });
  });

  it("sends free text cleaned and shortened, and refuses it when custom answers are off", async () => {
    const s = base();
    const parsed = parseRespond({
      ticket: 12,
      threadId: "t1",
      requestId: "r1",
      kind: "question",
      text: "  hallo\u0000 welt ",
    });
    expect(parsed).not.toBeNull();
    await handleRespond(parsed!, s);
    expect(s.host.respondUserInput).toHaveBeenCalledWith("t1", "r1", { q1: "hallo welt" });
    resetTicketRequests();
    const off = setup(
      [waiting("t1")],
      pendingOf([userInput("r1", undefined, { allowCustomAnswer: false })]),
      { 12: "t1" },
    );
    await handleRespond(q({ optionLabel: null, text: "frei" }), off);
    expect(off.host.respondUserInput).not.toHaveBeenCalled();
    expect(sent(off.target)[0]).toMatchObject({ result: "error" });
  });

  it("refuses a thread or ticket that does not belong together", async () => {
    const s = base();
    await handleRespond(q({ threadId: "t2" }), s);
    await handleRespond(q({ ticket: 99 }), s);
    expect(s.host.respondUserInput).not.toHaveBeenCalled();
    expect(sent(s.target).map((m) => m.result)).toEqual(["error", "error"]);
  });

  it("answers a request id only once", async () => {
    const s = base();
    await handleRespond(q(), s);
    await handleRespond(q({ optionLabel: "Ja (Recommended)" }), s);
    expect(s.host.respondUserInput).toHaveBeenCalledTimes(1);
    expect(sent(s.target).map((m) => m.result)).toEqual(["ok", "gone"]);
  });

  it("reports gone for a request that is no longer open and error for a failed send", async () => {
    const s = base();
    await handleRespond(q({ requestId: "r9" }), s);
    expect(sent(s.target)[0]).toMatchObject({ requestId: "r9", result: "gone" });
    s.host.respondUserInput.mockResolvedValueOnce(false);
    await handleRespond(q(), s);
    expect(sent(s.target)[1]).toMatchObject({ result: "error" });
    await handleRespond(q(), s); // failed send does not consume
    expect(sent(s.target)[2]).toMatchObject({ result: "ok" });
  });

  it("approves or declines a command only once and never with a wider decision", async () => {
    const s = base();
    const a = {
      ticket: 12,
      threadId: "t1",
      requestId: "r2",
      kind: "approval" as const,
      detail: "rm -rf build/",
    };
    await handleRespond({ ...a, decision: "accept" }, s);
    await handleRespond({ ...a, decision: "decline" }, s);
    expect(s.host.respondApproval).toHaveBeenCalledTimes(1);
    expect(s.host.respondApproval).toHaveBeenCalledWith("t1", "r2", "accept");
    expect(sent(s.target).map((m) => m.result)).toEqual(["ok", "gone"]);
    resetTicketRequests();
    const d = base();
    await handleRespond({ ...a, decision: "decline" }, d);
    expect(d.host.respondApproval).toHaveBeenCalledWith("t1", "r2", "decline");
    for (const decision of ["acceptForSession", "acceptAlways", "cancel", "", 1, undefined]) {
      expect(parseRespond({ ...a, decision })).toBeNull();
    }
  });

  it("does not answer a question message with an approval id and vice versa", async () => {
    const s = base();
    await handleRespond(q({ requestId: "r2" }), s);
    expect(s.host.respondUserInput).not.toHaveBeenCalled();
    expect(sent(s.target)[0]).toMatchObject({ result: "error" });
  });

  it("offers only shell commands whose text is the whole command", () => {
    const items = requestItems(
      pendingOf(
        [{ ...userInput("m"), responseCapability: "message" }],
        [
          approval("w", { requestKind: "file-change", detail: "Write: /x" }),
          approval("t", { detail: "Task: a long summary" }),
          approval("ok"),
        ],
      ),
    );
    expect(items.map((i) => [i.requestId, i.answerable])).toEqual(
      [
        ["m", false],
        ["ok", true],
        ["w", false],
        ["t", false],
      ].toSorted(
        (a, b) =>
          items.findIndex((i) => i.requestId === a[0]) -
          items.findIndex((i) => i.requestId === b[0]),
      ),
    );
  });

  it("keeps deceptive or oversized command text, but not answerable", () => {
    const texts = [
      "echo a\u202Eb",
      "echo a\u2066b",
      "echo a\u200Bb",
      "echo a\uFEFFb",
      "echo a\u2060b",
      "echo a\rb",
      "echo a\u0007b",
      "x".repeat(8001),
    ];
    const items = requestItems(
      pendingOf(
        [],
        [
          ...texts.map((detail, i) => approval(`d${i}`, { detail })),
          approval("fine", { detail: "a\n\tb" }),
        ],
        [...texts, "a\n\tb"],
      ),
    );
    for (const [i, text] of texts.entries()) {
      const item = items.find((entry) => entry.requestId === `d${i}`);
      expect(item?.answerable).toBe(false);
      expect(item?.approval?.detail).toBe(text);
    }
    expect(items.find((entry) => entry.requestId === "fine")?.answerable).toBe(true);
    const edge = "x".repeat(8000);
    expect(
      requestItems(pendingOf([], [approval("e", { detail: edge })], [edge]))[0]?.answerable,
    ).toBe(true);
  });

  it("refuses to approve a request that is not an answerable command", async () => {
    const s = setup(
      [waiting("t1")],
      pendingOf(
        [],
        [approval("w", { requestKind: "file-change", detail: "Write: /x" })],
        ["Write: /x"],
      ),
      { 12: "t1" },
    );
    await handleRespond(
      {
        ticket: 12,
        threadId: "t1",
        requestId: "w",
        kind: "approval",
        decision: "accept",
        detail: "Write: /x",
      },
      s,
    );
    expect(s.host.respondApproval).not.toHaveBeenCalled();
    expect(sent(s.target)[0]).toMatchObject({ result: "error" });
  });

  it("releases nothing when the shown detail differs or is missing", async () => {
    const s = base();
    const a = {
      ticket: 12,
      threadId: "t1",
      requestId: "r2",
      kind: "approval" as const,
      decision: "accept" as const,
    };
    await handleRespond({ ...a, detail: "rm -rf /" }, s);
    await handleRespond({ ...a, detail: null }, s);
    expect(s.host.respondApproval).not.toHaveBeenCalled();
    expect(sent(s.target).map((m) => m.result)).toEqual(["gone", "gone"]);
    expect(parseRespond({ ...a })).toMatchObject({ detail: null });
    await handleRespond({ ...a, detail: "rm -rf build/" }, s);
    expect(s.host.respondApproval).toHaveBeenCalledTimes(1);
  });

  it("refuses a question that is only answerable as a message", async () => {
    const s = setup(
      [waiting("t1")],
      pendingOf([{ ...userInput("r1"), responseCapability: "message" }]),
      { 12: "t1" },
    );
    await handleRespond(q(), s);
    expect(s.host.respondUserInput).not.toHaveBeenCalled();
    expect(sent(s.target)[0]).toMatchObject({ result: "error" });
  });

  it("reports gone when the send fails because the request was answered elsewhere", async () => {
    const s = base();
    await handleRequestsGet(12, s);
    s.host.respondUserInput.mockImplementationOnce(async () => {
      s.push(pendingOf());
      return false;
    });
    await handleRespond(q(), s);
    expect(sent(s.target).at(-1)).toMatchObject({ type: "fp:responded", result: "gone" });
  });

  it("checks the server assignment again on every message", async () => {
    const s = base();
    await handleRespond(q(), s);
    s.lookup.mockResolvedValue({ threadId: "t2" });
    await handleRespond(q({ requestId: "r1b" }), s);
    expect(sent(s.target).map((m) => m.result)).toEqual(["ok", "error"]);
    expect(s.host.respondUserInput).toHaveBeenCalledTimes(1);
  });

  it("validates the message fields", () => {
    const ok = { ticket: 12, threadId: "t1", requestId: "r1", kind: "question", optionLabel: "A" };
    expect(parseRespond(ok)).not.toBeNull();
    expect(parseRespond({ ...ok, ticket: "12" })).toBeNull();
    expect(parseRespond({ ...ok, ticket: 0 })).toBeNull();
    expect(parseRespond({ ...ok, threadId: "" })).toBeNull();
    expect(parseRespond({ ...ok, kind: "other" })).toBeNull();
    expect(parseRespond({ ...ok, text: "x" })).toBeNull(); // both
    expect(parseRespond({ ...ok, optionLabel: undefined })).toBeNull(); // neither
    expect(parseRespond({ ...ok, optionLabel: undefined, text: "x".repeat(4001) })).toBeNull();
    expect(parseRespond({ ...ok, optionLabel: undefined, text: "x".repeat(4000) })).not.toBeNull();
  });
});

describe("origin and source for the new types (OP#1842)", () => {
  beforeEach(() => resetTicketRequests());

  it("ignores fp:requests-get and fp:respond from a foreign origin", () => {
    const s = setup([waiting("t1")], pendingOf([userInput("r1")]), { 12: "t1" });
    setTicketRequestsHost(s.host);
    expect(applyParentMessage({ type: "fp:requests-get", ticket: 12 }, "http://evil.example")).toBe(
      false,
    );
    expect(
      applyParentMessage(
        {
          type: "fp:respond",
          ticket: 12,
          threadId: "t1",
          requestId: "r1",
          kind: "approval",
          decision: "accept",
        },
        "http://evil.example",
      ),
    ).toBe(false);
    expect(s.host.watch).not.toHaveBeenCalled();
    expect(s.host.respondApproval).not.toHaveBeenCalled();
    setTicketRequestsHost(null);
  });

  it("rejects invalid tickets and decisions from the right origin", () => {
    expect(applyParentMessage({ type: "fp:requests-get", ticket: "12" }, PARENT_ORIGIN)).toBe(
      false,
    );
    expect(applyParentMessage({ type: "fp:requests-get", ticket: -1 }, PARENT_ORIGIN)).toBe(false);
    expect(
      applyParentMessage(
        {
          type: "fp:respond",
          ticket: 12,
          threadId: "t1",
          requestId: "r1",
          kind: "approval",
          decision: "acceptAlways",
        },
        PARENT_ORIGIN,
      ),
    ).toBe(false);
  });

  it("only takes the message from the parent window", () => {
    const parent = {};
    expect(acceptParentSource(parent, parent)).toBe(true);
    expect(acceptParentSource({}, parent)).toBe(false);
  });
});
