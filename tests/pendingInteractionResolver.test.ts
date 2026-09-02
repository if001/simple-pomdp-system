import assert from "node:assert/strict";
import { test } from "vitest";
import { createPendingInteractionResolver } from "../src/simple_pomdp/infrastructure/pendingInteractionResolver";
import { InteractionLog, TurnRecord } from "../src/simple_pomdp/domain/types";

const NOW = new Date("2026-09-02T06:00:00.000Z");

test("restores a scheduled interaction after process restart", async () => {
  const resolver = createResolver(
    [interaction("scheduled-1", "scheduled", "05:00")],
    [turn("proactive", "scheduled-1", "05:01")],
  );

  assert.equal(await resolve(resolver), "scheduled-1");
});

test("restores a conversation trigger without treating its trigger record as reaction", async () => {
  const resolver = createResolver(
    [interaction("conversation-1", "conversation", "05:00")],
    [turn("human", "conversation-1", "05:01")],
  );

  assert.equal(await resolve(resolver), "conversation-1");
});

test("does not reuse a conversation interaction after a later human reaction", async () => {
  const resolver = createResolver(
    [interaction("conversation-1", "conversation", "05:00")],
    [
      turn("human", "conversation-1", "05:01"),
      turn("human", "conversation-1", "05:10"),
    ],
  );

  assert.equal(await resolve(resolver), null);
});

test("selects only the newest valid interaction", async () => {
  const resolver = createResolver(
    [
      interaction("older", "scheduled", "04:00"),
      interaction("newer", "scheduled", "05:00"),
    ],
    [
      turn("proactive", "older", "04:01"),
      turn("proactive", "newer", "05:01"),
    ],
  );

  assert.equal(await resolve(resolver), "newer");
});

test.each(["resolved", "expired"] as const)(
  "excludes %s interactions",
  async (status) => {
    const log = interaction("inactive", "scheduled", "05:00");
    log.status = status;
    const resolver = createResolver(
      [log],
      [turn("proactive", "inactive", "05:01")],
    );

    assert.equal(await resolve(resolver), null);
  },
);

test("excludes timed-out interactions", async () => {
  const resolver = createResolver(
    [interaction("timed-out", "scheduled", "03:00")],
    [turn("proactive", "timed-out", "03:01")],
    60 * 60 * 1000,
  );

  assert.equal(await resolve(resolver), null);
});

const createResolver = (
  logs: InteractionLog[],
  turns: TurnRecord[],
  pendingTimeoutMs = 6 * 60 * 60 * 1000,
) =>
  createPendingInteractionResolver({
    interactionLogStore: {
      listRecentInteractionLogs: async ({ botId, userId, limit }) =>
        logs
          .filter((log) => log.botId === botId && log.userId === userId)
          .slice(-limit),
    },
    turnRecordReader: {
      listRecentTurnRecords: async ({ botId, threadId, limit }) =>
        turns
          .filter(
            (turn) => turn.botId === botId && turn.threadId === threadId,
          )
          .slice(-limit),
    },
    pendingTimeoutMs,
    now: () => NOW,
  });

const resolve = (resolver: ReturnType<typeof createResolver>) =>
  resolver.resolve({
    botId: "ao",
    threadId: "channel-1:user-1",
    userId: "user-1",
  });

const interaction = (
  id: string,
  trigger: "scheduled" | "conversation",
  time: string,
): InteractionLog => ({
  id,
  botId: "ao",
  userId: "user-1",
  threadId: "channel-1:user-1",
  candidateKind: "explore",
  trigger,
  message: id,
  status: "pending",
  observation: "unknown",
  feedbackNote: "",
  observeWindowTurns: 2,
  createdAtIso: `2026-09-02T${time}:00.000Z`,
});

const turn = (
  kind: "human" | "proactive",
  sourceInteractionId: string,
  time: string,
): TurnRecord => ({
  botId: "ao",
  threadId: "channel-1:user-1",
  kind,
  sourceInteractionId,
  messages: [],
  createdAtIso: `2026-09-02T${time}:00.000Z`,
});
