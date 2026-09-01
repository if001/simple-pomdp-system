import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createRecentTurnContextSource,
  createTopicStateInteractionLogContextSource,
  createUserMemoryContextSource,
} from "../src/simple_pomdp/infrastructure/contextSources";
import {
  InteractionLog,
  ProactiveContextInput,
  UserBelief,
} from "../src/simple_pomdp/domain/types";

const input: ProactiveContextInput = {
  botId: "ao",
  threadId: "thread-1",
  userId: "user-1",
};

test("recent turn source scopes its reader and excludes internal messages", async () => {
  const calls: unknown[] = [];
  const source = createRecentTurnContextSource({
    limit: 3,
    maxItemLength: 120,
    reader: {
      listRecentTurnRecords: async (readerInput) => {
        calls.push(readerInput);
        return [
          {
            botId: "ao",
            threadId: "thread-1",
            kind: "delegation",
            createdAtIso: "2026-09-01T00:00:00.000Z",
            messages: [
              {
                role: "user",
                content: "internal delegation",
                timestampIso: "2026-09-01T00:00:00.000Z",
              },
            ],
          },
          {
            botId: "ao",
            threadId: "thread-1",
            kind: "proactive",
            createdAtIso: "2026-09-01T00:01:00.000Z",
            messages: [
              {
                role: "user",
                content: "internal proactive instruction",
                timestampIso: "2026-09-01T00:01:00.000Z",
              },
              {
                role: "assistant",
                content: "visible proactive response",
                timestampIso: "2026-09-01T00:01:01.000Z",
              },
            ],
          },
        ];
      },
    },
  });

  const context = await source.load(input);

  assert.deepEqual(calls, [
    { botId: "ao", threadId: "thread-1", limit: 3 },
  ]);
  assert.equal(context.length, 1);
  assert.match(context[0] ?? "", /visible proactive response/);
  assert.doesNotMatch(context[0] ?? "", /internal/);
  assert.ok((context[0]?.length ?? 0) <= 120);
});

test("user memory source scopes, filters, and limits memory items", async () => {
  const calls: unknown[] = [];
  const source = createUserMemoryContextSource({
    limit: 2,
    maxItemLength: 40,
    reader: {
      listRecentUserMemory: async (readerInput) => {
        calls.push(readerInput);
        return [
          { text: "TypeScriptに関心がある" },
          { text: "長い記憶".repeat(20) },
          { text: "limit外" },
        ];
      },
    },
  });

  const context = await source.load(input);

  assert.deepEqual(calls, [{ botId: "ao", userId: "user-1", limit: 2 }]);
  assert.equal(context.length, 2);
  assert.ok(context.every((item) => item.length <= 40));
  assert.doesNotMatch(context.join(" "), /limit外/);
});

test("topic and interaction source reads one user and filters interaction scope", async () => {
  const belief: UserBelief = {
    userId: "user-1",
    topics: [
      {
        id: "topic-1",
        domain: "IT",
        topic: "testing",
        interest: 1,
        confidence: "medium",
        attemptCount: 1,
        positiveCount: 1,
        negativeCount: 0,
        lastObservedAtIso: "2026-09-01T00:00:00.000Z",
      },
    ],
    initiationTolerance: "medium",
    initiationPositiveCount: 1,
    initiationNegativeCount: 0,
    initiationNoResponseCount: 0,
    updatedAtIso: "2026-09-01T00:00:00.000Z",
  };
  const logs: InteractionLog[] = [
    interaction("matching", "ao", "thread-1"),
    interaction("wrong-bot", "aka", "thread-1"),
    interaction("wrong-thread", "ao", "thread-2"),
  ];
  const beliefCalls: string[] = [];
  const logCalls: unknown[] = [];
  const source = createTopicStateInteractionLogContextSource({
    limit: 4,
    userBeliefReader: {
      getUserBelief: async (userId) => {
        beliefCalls.push(userId);
        return belief;
      },
    },
    interactionLogReader: {
      listRecentInteractionLogs: async (readerInput) => {
        logCalls.push(readerInput);
        return logs;
      },
    },
  });

  const context = await source.load(input);

  assert.deepEqual(beliefCalls, ["user-1"]);
  assert.deepEqual(logCalls, [{ userId: "user-1", limit: 4 }]);
  assert.match(context.join(" "), /topic=testing/);
  assert.match(context.join(" "), /message=matching/);
  assert.doesNotMatch(context.join(" "), /wrong-bot|wrong-thread/);
});

const interaction = (
  message: string,
  botId: string,
  threadId: string,
): InteractionLog => ({
  id: message,
  userId: "user-1",
  botId,
  threadId,
  candidateKind: "explore",
  targetDomain: "IT",
  message,
  status: "resolved",
  observation: "neutral",
  feedbackNote: "",
  observeWindowTurns: 2,
  createdAtIso: "2026-09-01T00:00:00.000Z",
});
