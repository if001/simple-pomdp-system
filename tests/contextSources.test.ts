import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createMemoryServiceContextSource,
  createRecentTurnContextSource,
  createSavedKnowledgeContextSource,
  createTopicStateInteractionLogContextSource,
  createUserMemoryContextSource,
} from "../src/simple_pomdp/infrastructure/contextSources";
import {
  InteractionLog,
  ProactiveContextInput,
  TopicStateSnapshot,
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

test("shared saved knowledge source searches from supplied recent context", async () => {
  const calls: unknown[] = [];
  const source = createSavedKnowledgeContextSource({
    knowledgeAccessService: {
      searchSavedKnowledge: async (input) => {
        calls.push(input);
        return [{ articleId: "article-1", score: 0.9, title: "Agent design", summary: "shared summary", tags: ["agent"], url: "https://example.com/a" }];
      },
    },
  });

  const result = await source.load({ botId: "ao", threadId: "thread-1", userId: "user-1", currentContext: "agent設計について話している" });

  assert.deepEqual(calls, [{ query: "agent設計について話している", limit: 3, minScore: 0.35 }]);
  assert.match(result[0] ?? "", /articleId=article-1/);
  assert.doesNotMatch(result[0] ?? "", /score=/);
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

test("memory service source retrieves conversation and user context through one scoped search", async () => {
  const calls: unknown[] = [];
  const source = createMemoryServiceContextSource({
    limit: 3,
    memoryService: {
      search: async (request) => {
        calls.push(request);
        return {
          conversationHistory: {
            status: "found",
            data: [{ occurredAt: "2026-09-01T00:00:00.000Z", excerpt: "以前の会話" }],
          },
          userMemory: {
            status: "found",
            data: [{ note: "TypeScriptが好き" }],
          },
        };
      },
    },
  });

  const context = await source.load(input);

  assert.deepEqual(calls, [{
    ...input,
    query: "recent conversation and durable user context",
    scopes: ["conversation_history", "user_memory"],
    limits: { conversation_history: 3, user_memory: 3 },
  }]);
  assert.match(context.join(" "), /以前の会話/);
  assert.match(context.join(" "), /TypeScriptが好き/);
});

test("topic and interaction source reads one user and filters interaction scope", async () => {
  const state: TopicStateSnapshot = {
    userId: "user-1",
    topics: [
      {
        topic: "testing",
        assessment: "interested",
        evidence: "テストの話題に前向きだった",
        lastTriedAt: "2026-09-01T00:00:00.000Z",
      },
    ],
    updatedAtIso: "2026-09-01T00:00:00.000Z",
  };
  const logs: InteractionLog[] = [
    interaction("matching", "ao", "thread-1"),
    interaction("wrong-bot", "aka", "thread-1"),
    interaction("wrong-thread", "ao", "thread-2"),
  ];
  const beliefCalls: unknown[] = [];
  const logCalls: unknown[] = [];
  const source = createTopicStateInteractionLogContextSource({
    limit: 4,
    topicStateReader: {
      getTopicState: async (readerInput) => {
        beliefCalls.push(readerInput);
        return state;
      },
    },
    interactionLogReader: {
      listRecentInteractionLogs: async (readerInput) => {
        logCalls.push(readerInput);
        return logs.filter(
          (log) =>
            log.botId === readerInput.botId &&
            log.userId === readerInput.userId,
        );
      },
    },
  });

  const context = await source.load(input);

  assert.deepEqual(beliefCalls, [{ botId: "ao", userId: "user-1" }]);
  assert.deepEqual(logCalls, [
    { botId: "ao", userId: "user-1", limit: 4 },
  ]);
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
  trigger: "scheduled",
  targetDomain: "IT",
  message,
  status: "resolved",
  observation: "neutral",
  feedbackNote: "",
  observeWindowTurns: 2,
  createdAtIso: "2026-09-01T00:00:00.000Z",
});
