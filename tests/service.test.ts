import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createSimplePomdpSystemService,
  type SimplePomdpSystemOptions,
} from "../src/simple_pomdp/api/service";
import {
  BackgroundInput,
  DialoguePlanningModel,
  InteractionLog,
  InteractionLogStore,
  TurnRecord,
  TurnRecordStore,
  UserBelief,
  UserBeliefStore,
} from "../src/simple_pomdp/domain/types";

test("dispatchNext selects a candidate and enqueues a background instruction", async () => {
  const enqueued: BackgroundInput[] = [];
  const service = createTestService({
    turnRecordStore: createInMemoryTurnRecordStore([
      userTurn("ao", "thread-1", "2026-06-14T00:00:00.000Z", "最近は実装の話題が多いです"),
    ]),
    userBeliefStore: createInMemoryUserBeliefStore(),
    interactionLogStore: createInMemoryInteractionLogStore(),
    backgroundInputSink: { enqueue: async (input) => enqueued.push(input) },
    now: () => new Date("2026-06-14T01:00:00.000Z"),
  });

  const dispatched = await service.dispatchNext({
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  assert.equal(dispatched.length, 1);
  assert.equal(enqueued.length, 1);
  assert.match(
    dispatched[0]?.text ?? "",
    /これはユーザーからの入力ではなく、background からの介入指示です。/,
  );
});

test("dispatchNext observes user reaction and updates belief on next cycle", async () => {
  const interactionLogStore = createInMemoryInteractionLogStore();
  const userBeliefStore = createInMemoryUserBeliefStore();
  const turnRecordStore = createInMemoryTurnRecordStore([
    assistantTurn("ao", "thread-1", "2026-06-14T00:00:00.000Z", "最初の補足です。"),
    userTurn("ao", "thread-1", "2026-06-14T00:01:00.000Z", "その方向はかなり興味があります"),
  ]);
  await interactionLogStore.saveInteractionLog({
    id: "log-1",
    userId: "discord-user",
    botId: "ao",
    threadId: "thread-1",
    candidateKind: "exploit",
    probeType: "exploit",
    targetDomain: "IT",
    targetTopic: "implementation",
    message: "実装に関する補足を共有したい",
    status: "pending",
    observation: "unknown",
    feedbackNote: "",
    observeWindowTurns: 3,
    createdAtIso: "2026-06-14T00:00:00.000Z",
  });

  const service = createTestService({
    turnRecordStore,
    userBeliefStore,
    interactionLogStore,
    now: () => new Date("2026-06-14T02:00:00.000Z"),
  });

  const dispatched = await service.dispatchNext({
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  assert.equal(dispatched.length, 1);
  const belief = await service.listUserBelief({ userId: "discord-user" });
  assert.equal(belief?.topics[0]?.domain, "IT");
  assert.equal(belief?.topics[0]?.topic, "implementation");
  assert.equal(belief?.topics[0]?.interest, 1);
  assert.equal(belief?.topics[0]?.positiveCount, 1);
  assert.equal(belief?.initiationPositiveCount, 1);
  const logs = await interactionLogStore.listRecentInteractionLogs({
    userId: "discord-user",
    limit: 10,
  });
  assert.equal(logs[0]?.observation, "positive");
  assert.equal(logs[0]?.status, "resolved");
});

test("dispatchNext expires pending interaction after observe window without user response", async () => {
  const interactionLogStore = createInMemoryInteractionLogStore();
  const userBeliefStore = createInMemoryUserBeliefStore();
  const turnRecordStore = createInMemoryTurnRecordStore([
    assistantTurn("ao", "thread-1", "2026-06-14T00:01:00.000Z", "補足を続けます。"),
    assistantTurn("ao", "thread-1", "2026-06-14T00:02:00.000Z", "もう一点あります。"),
    assistantTurn("ao", "thread-1", "2026-06-14T00:03:00.000Z", "以上です。"),
  ]);
  await interactionLogStore.saveInteractionLog({
    id: "log-2",
    userId: "discord-user",
    botId: "ao",
    threadId: "thread-1",
    candidateKind: "explore",
    probeType: "breadth",
    targetDomain: "IT",
    targetTopic: "testing",
    message: "テスト観点の話をしてもよいか確認したい",
    status: "pending",
    observation: "unknown",
    feedbackNote: "",
    observeWindowTurns: 2,
    createdAtIso: "2026-06-14T00:00:00.000Z",
  });

  const service = createTestService({
    turnRecordStore,
    userBeliefStore,
    interactionLogStore,
    maxPendingInteractions: 10,
    now: () => new Date("2026-06-14T02:00:00.000Z"),
  });

  await service.dispatchNext({
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  const belief = await service.listUserBelief({ userId: "discord-user" });
  assert.equal(belief?.initiationNoResponseCount, 1);
  const logs = await interactionLogStore.listRecentInteractionLogs({
    userId: "discord-user",
    limit: 10,
  });
  const expired = logs.find((log) => log.id === "log-2");
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.observation, "no_response");
});

test("dispatchNext expires pending interaction after timeout even without enough turns", async () => {
  const interactionLogStore = createInMemoryInteractionLogStore();
  const userBeliefStore = createInMemoryUserBeliefStore();
  const turnRecordStore = createInMemoryTurnRecordStore([]);
  await interactionLogStore.saveInteractionLog({
    id: "log-3",
    userId: "discord-user",
    botId: "ao",
    threadId: "thread-1",
    candidateKind: "refine",
    probeType: "depth",
    targetDomain: "IT",
    targetTopic: "release-notes",
    message: "最近の更新情報に興味があるか確認したい",
    status: "pending",
    observation: "unknown",
    feedbackNote: "",
    observeWindowTurns: 5,
    createdAtIso: "2026-06-14T00:00:00.000Z",
  });

  const service = createTestService({
    turnRecordStore,
    userBeliefStore,
    interactionLogStore,
    pendingTimeoutMs: 60 * 60 * 1000,
    maxPendingInteractions: 10,
    now: () => new Date("2026-06-14T02:00:00.000Z"),
  });

  await service.dispatchNext({
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  const logs = await interactionLogStore.listRecentInteractionLogs({
    userId: "discord-user",
    limit: 10,
  });
  const expired = logs.find((log) => log.id === "log-3");
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.observation, "no_response");
});

test("dispatchNext records do_nothing and passes inactivity buckets to planner", async () => {
  const interactionLogStore = createInMemoryInteractionLogStore([
    {
      id: "log-previous",
      userId: "discord-user",
      botId: "ao",
      threadId: "thread-1",
      candidateKind: "exploit",
      probeType: "exploit",
      targetDomain: "IT",
      targetTopic: "implementation",
      message: "以前の補足です",
      status: "resolved",
      observation: "no_response",
      feedbackNote: "反応なし",
      observeWindowTurns: 3,
      createdAtIso: "2026-06-14T00:00:00.000Z",
      resolvedAtIso: "2026-06-14T01:00:00.000Z",
    },
  ]);
  const turnRecordStore = createInMemoryTurnRecordStore([
    userTurn("ao", "thread-1", "2026-06-14T01:00:00.000Z", "こんにちは"),
  ]);
  let capturedPrompt = "";
  const service = createTestService({
    turnRecordStore,
    userBeliefStore: createInMemoryUserBeliefStore(),
    interactionLogStore,
    now: () => new Date("2026-06-14T04:00:00.000Z"),
    plannerModel: {
      generateJson: async (_systemPrompt, userPrompt) => {
        capturedPrompt = userPrompt;
        return {
          candidates: [
          {
            kind: "do_nothing",
            intent: "今は何もしない",
            expectedBenefit: "low",
            expectedRisk: "low",
            reason: "まだ待つ",
          },
          ],
          selectedIndex: 0,
        };
      },
    },
  });

  const dispatched = await service.dispatchNext({
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  assert.equal(dispatched.length, 0);
  assert.match(capturedPrompt, /"hoursSinceLastUserTurnBucket":"3h"/);
  assert.match(capturedPrompt, /"hoursSinceLastAgentInitiatedBucket":"4h"/);
  assert.match(capturedPrompt, /"recentNoResponseCount":1/);
  const logs = await interactionLogStore.listRecentInteractionLogs({
    userId: "discord-user",
    limit: 10,
  });
  const doNothing = logs.find((log) => log.candidateKind === "do_nothing");
  assert.equal(doNothing?.status, "resolved");
  assert.equal(doNothing?.observation, "unknown");
});

test("dispatchNext skips outside configured interaction hours", async () => {
  let plannerCalled = false;
  const service = createTestService({
    turnRecordStore: createInMemoryTurnRecordStore([
      userTurn("ao", "thread-1", "2026-06-14T00:00:00.000Z", "最近どう？"),
    ]),
    userBeliefStore: createInMemoryUserBeliefStore(),
    interactionLogStore: createInMemoryInteractionLogStore(),
    interactionStartHour: 10,
    interactionEndHour: 24,
    now: () => new Date(2026, 5, 14, 9, 0, 0, 0),
    plannerModel: {
      generateJson: async () => {
        plannerCalled = true;
        return {
          candidates: [],
          selectedIndex: 0,
        };
      },
    },
  });

  const dispatched = await service.dispatchNext({
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  assert.equal(dispatched.length, 0);
  assert.equal(plannerCalled, false);
});

function createTestService(
  options: Omit<SimplePomdpSystemOptions, "plannerModel"> & {
    plannerModel?: DialoguePlanningModel;
  },
) {
  return createSimplePomdpSystemService({
    ...options,
    plannerModel: options.plannerModel ?? createDefaultPlannerModel(),
  });
}

function createDefaultPlannerModel(): DialoguePlanningModel {
  return {
    generateJson: async (_systemPrompt, userPrompt) => {
      if (userPrompt.includes("\"currentBelief\"")) {
        return {
          updates: [
            {
              targetDomain: "IT",
              targetTopic: "implementation",
              interestDelta: 1,
              confidenceDelta: 1,
              initiationToleranceDelta: 0,
              note: "明示的に関心を示した",
            },
          ],
        };
      }
      if (userPrompt.includes("\"message\":") && userPrompt.includes("\"observedWindow\":")) {
        return {
          observation: "positive",
          feedbackNote: "ユーザーは前向きな関心を示した",
        };
      }
      return {
        candidates: [
          {
            kind: "exploit",
            probeType: "exploit",
            targetDomain: "IT",
            targetTopic: "implementation",
            intent: "最近の実装に近い話題を短く補足する",
            draftMessage: "最近の実装で役立ちそうな関連情報を短く共有したいです。",
            expectedBenefit: "high",
            expectedRisk: "low",
            reason: "実装話題への関心が高そうだから",
          },
          {
            kind: "do_nothing",
            intent: "今は何もしない",
            expectedBenefit: "low",
            expectedRisk: "low",
            reason: "様子を見る",
          },
        ],
        selectedIndex: 0,
      };
    },
  };
}

function createInMemoryTurnRecordStore(initial: TurnRecord[] = []): TurnRecordStore {
  const items = [...initial];
  return {
    appendTurnRecord: async (turn) => {
      items.push(turn);
    },
    listRecentTurnRecords: async ({ botId, threadId, limit }) =>
      items.filter((turn) => turn.botId === botId && turn.threadId === threadId).slice(-limit),
  };
}

function createInMemoryUserBeliefStore(
  initial: UserBelief | null = null,
): UserBeliefStore {
  let item = initial;
  return {
    getUserBelief: async () => item,
    saveUserBelief: async (belief) => {
      item = belief;
    },
  };
}

function createInMemoryInteractionLogStore(
  initial: InteractionLog[] = [],
): InteractionLogStore {
  const items = [...initial];
  return {
    listRecentInteractionLogs: async ({ userId, limit }) =>
      items.filter((log) => log.userId === userId).slice(-limit),
    saveInteractionLog: async (log) => {
      const next = items.filter((item) => item.id !== log.id);
      next.push(log);
      items.splice(0, items.length, ...next);
    },
  };
}

function userTurn(
  botId: string,
  threadId: string,
  createdAtIso: string,
  content: string,
): TurnRecord {
  return {
    botId,
    threadId,
    createdAtIso,
    messages: [{ role: "user", content, timestampIso: createdAtIso }],
  };
}

function assistantTurn(
  botId: string,
  threadId: string,
  createdAtIso: string,
  content: string,
): TurnRecord {
  return {
    botId,
    threadId,
    createdAtIso,
    messages: [{ role: "assistant", content, timestampIso: createdAtIso }],
  };
}
