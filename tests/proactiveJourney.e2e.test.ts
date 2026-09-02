import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createSimplePomdpSystemService,
  DialogueDecision,
  InteractionLog,
  InteractionLogStore,
  ScheduledAgentInput,
  TopicStateSnapshot,
  TopicStateStore,
  TurnRecord,
  TurnRecordReader,
} from "../src";

test("fixed journey progresses explore to refine to exploit with one traced dispatch each", async () => {
  const turns: TurnRecord[] = [];
  const logs: InteractionLog[] = [];
  const enqueued: ScheduledAgentInput[] = [];
  let state: TopicStateSnapshot | null = null;
  let now = new Date("2026-09-01T00:00:00.000Z");
  const decisions: DialogueDecision[] = [
    {
      kind: "explore",
      targetDomain: "engineering",
      targetTopic: "testing",
      messageIntent: "テストへの関心を短く確認する",
      reason: "未試行領域を探索する",
    },
    {
      kind: "refine",
      targetDomain: "engineering",
      targetTopic: "property testing",
      messageIntent: "関心があったテスト手法を少し掘り下げる",
      reason: "testingへの肯定反応があった",
    },
    {
      kind: "exploit",
      targetDomain: "engineering",
      targetTopic: "property testing",
      messageIntent: "property testingの実践例を共有する",
      reason: "継続して肯定反応があった",
    },
  ];
  const turnRecordReader: TurnRecordReader = {
    listRecentTurnRecords: async ({ botId, threadId, limit }) =>
      turns
        .filter((turn) => turn.botId === botId && turn.threadId === threadId)
        .slice(-limit),
  };
  const topicStateStore: TopicStateStore = {
    getTopicState: async () => state,
    saveTopicState: async ({ state: next }) => {
      state = next;
    },
  };
  const interactionLogStore: InteractionLogStore = {
    listRecentInteractionLogs: async ({ botId, userId, limit }) =>
      logs
        .filter((log) => log.botId === botId && log.userId === userId)
        .slice(-limit),
    saveInteractionLog: async (next) => {
      const index = logs.findIndex((log) => log.id === next.id);
      if (index >= 0) {
        logs[index] = next;
      } else {
        logs.push(next);
      }
    },
  };
  const service = createSimplePomdpSystemService({
    turnRecordReader,
    topicStateStore,
    interactionLogStore,
    contextSources: [],
    backgroundInputSink: {
      enqueue: async (input) => {
        enqueued.push(input);
      },
    },
    plannerModel: {
      generateJson: async <T>(_systemPrompt: string, userPrompt: string) => {
        if (userPrompt.includes('"observedWindow"')) {
          return {
            observation: "positive",
            feedbackNote: "ユーザーが明示的に続きを求めた",
          } as T;
        }
        const decision = decisions.shift();
        assert.ok(decision);
        return decision as T;
      },
    },
    initialDomainCandidates: ["engineering", "music"],
    observeWindowTurns: 1,
    now: () => now,
  });

  const run = async () => {
    const output = await service.runTrigger({
      botId: "ao",
      threadId: "thread-1",
      userId: "user-1",
      trigger: "scheduled",
    });
    assert.ok(output);
    return output;
  };
  const react = (sourceInteractionId: string, content: string) => {
    const createdAtIso = new Date(now.getTime() + 1_000).toISOString();
    turns.push({
      botId: "ao",
      threadId: "thread-1",
      kind: "human",
      sourceInteractionId,
      createdAtIso,
      messages: [{ role: "user", content, timestampIso: createdAtIso }],
    });
  };

  const explored = await run();
  react(explored.sourceInteractionId, "そのテストの話は興味があります");
  now = new Date("2026-09-01T01:00:00.000Z");
  const refined = await run();
  react(refined.sourceInteractionId, "property testingも詳しく知りたいです");
  now = new Date("2026-09-01T02:00:00.000Z");
  const exploited = await run();

  assert.deepEqual(
    logs.map((log) => log.candidateKind),
    ["explore", "refine", "exploit"],
  );
  assert.deepEqual(
    logs.slice(0, 2).map((log) => log.observation),
    ["positive", "positive"],
  );
  assert.equal(enqueued.length, 3);
  assert.deepEqual(
    enqueued.map((input) => input.sourceInteractionId),
    [
      explored.sourceInteractionId,
      refined.sourceInteractionId,
      exploited.sourceInteractionId,
    ],
  );
  assert.deepEqual(
    turns.map((turn) => turn.sourceInteractionId),
    [explored.sourceInteractionId, refined.sourceInteractionId],
  );
  assert.equal(
    state?.topics.find((topic) => topic.topic === "property testing")
      ?.assessment,
    "interested",
  );
});
