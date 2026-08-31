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

test("dispatchNext applies a dialogue decision and enqueues a background instruction", async () => {
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
  const domainBelief = belief?.topics.find(
    (topic) => topic.domain === "IT" && topic.topic === undefined,
  );
  const topicBelief = belief?.topics.find(
    (topic) => topic.domain === "IT" && topic.topic === "implementation",
  );
  assert.equal(domainBelief?.interest, 1);
  assert.equal(domainBelief?.positiveCount, 1);
  assert.equal(topicBelief?.interest, 1);
  assert.equal(topicBelief?.positiveCount, 1);
  assert.equal(belief?.initiationPositiveCount, 1);
  const logs = await interactionLogStore.listRecentInteractionLogs({
    userId: "discord-user",
    limit: 10,
  });
  assert.equal(logs[0]?.observation, "positive");
  assert.equal(logs[0]?.status, "resolved");
});

test("existing domain and topic beliefs are updated in place without duplication", async () => {
  const interactionLogStore = createInMemoryInteractionLogStore();
  const userBeliefStore = createInMemoryUserBeliefStore({
    userId: "discord-user",
    topics: [
      {
        id: "domain_IT",
        domain: "IT",
        interest: 1,
        confidence: "medium",
        attemptCount: 2,
        positiveCount: 1,
        negativeCount: 0,
        lastObservedAtIso: "2026-06-14T00:00:00.000Z",
      },
      {
        id: "topic_IT_implementation",
        domain: "IT",
        topic: "implementation",
        interest: 1,
        confidence: "medium",
        attemptCount: 2,
        positiveCount: 1,
        negativeCount: 0,
        lastObservedAtIso: "2026-06-14T00:00:00.000Z",
      },
    ],
    initiationTolerance: "medium",
    initiationPositiveCount: 1,
    initiationNegativeCount: 0,
    initiationNoResponseCount: 0,
    updatedAtIso: "2026-06-14T00:00:00.000Z",
  });
  const turnRecordStore = createInMemoryTurnRecordStore([
    assistantTurn("ao", "thread-1", "2026-06-14T01:00:00.000Z", "補足です。"),
    userTurn("ao", "thread-1", "2026-06-14T01:01:00.000Z", "それは引き続き気になります"),
  ]);
  await interactionLogStore.saveInteractionLog({
    id: "log-existing",
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
    createdAtIso: "2026-06-14T01:00:00.000Z",
  });

  const service = createTestService({
    turnRecordStore,
    userBeliefStore,
    interactionLogStore,
    now: () => new Date("2026-06-14T02:00:00.000Z"),
  });

  await service.dispatchNext({
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  const belief = await service.listUserBelief({ userId: "discord-user" });
  const domainBeliefs = belief?.topics.filter(
    (topic) => topic.domain === "IT" && topic.topic === undefined,
  );
  const topicBeliefs = belief?.topics.filter(
    (topic) => topic.domain === "IT" && topic.topic === "implementation",
  );
  assert.equal(domainBeliefs?.length, 1);
  assert.equal(topicBeliefs?.length, 1);
  assert.equal(domainBeliefs?.[0]?.attemptCount, 3);
  assert.equal(topicBeliefs?.[0]?.attemptCount, 3);
  assert.equal(domainBeliefs?.[0]?.positiveCount, 2);
  assert.equal(topicBeliefs?.[0]?.positiveCount, 2);
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
  const domainBelief = belief?.topics.find(
    (topic) => topic.domain === "IT" && topic.topic === undefined,
  );
  assert.equal(domainBelief?.interest, 0);
  assert.equal(domainBelief?.confidence, "low");
  assert.equal(domainBelief?.attemptCount, 1);
  assert.equal(
    belief?.topics.some((topic) => topic.topic === "testing"),
    false,
  );
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
          kind: "do_nothing",
          reason: "まだ待つ",
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
  assert.match(capturedPrompt, /"currentSituation":\{/);
  assert.match(capturedPrompt, /"dayOfWeek":"Sunday"/);
  assert.match(capturedPrompt, /"timeBucket":"daytime"/);
  assert.match(capturedPrompt, /"recentInteractions":\[/);
  assert.match(capturedPrompt, /"observation":"no_response"/);
  assert.match(capturedPrompt, /"elapsed":"4h"/);
  assert.match(capturedPrompt, /"sentDate":"2026-06-14"/);
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
          kind: "do_nothing",
          reason: "時間外",
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

test("dispatchNext uses exploit research result in instruction and interaction log", async () => {
  const enqueued: BackgroundInput[] = [];
  const interactionLogStore = createInMemoryInteractionLogStore();
  const service = createTestService({
    turnRecordStore: createInMemoryTurnRecordStore([
      userTurn("ao", "thread-1", "2026-06-14T00:00:00.000Z", "TypeScript 最近どう？"),
    ]),
    userBeliefStore: createInMemoryUserBeliefStore(),
    interactionLogStore,
    backgroundInputSink: { enqueue: async (input) => enqueued.push(input) },
    now: () => new Date("2026-06-14T12:00:00.000Z"),
    exploitResearchAgent: {
      research: async () => ({
        summary: "TypeScript の新しい更新点として型推論と設定周りの改善がある。",
        articleIds: ["article_1"],
        sourceUrls: ["https://example.com/ts"],
        notes: ["saved knowledge と web を併用した"],
      }),
    },
  });

  await service.dispatchNext({
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0]?.text ?? "", /調査結果: TypeScript の新しい更新点/);
  assert.match(enqueued[0]?.text ?? "", /articleIds: article_1/);
  const logs = await interactionLogStore.listRecentInteractionLogs({
    userId: "discord-user",
    limit: 10,
  });
  assert.equal(logs[0]?.supportSummary, "TypeScript の新しい更新点として型推論と設定周りの改善がある。");
  assert.deepEqual(logs[0]?.articleIds, ["article_1"]);
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
      if (userPrompt.includes("\"message\":") && userPrompt.includes("\"observedWindow\":")) {
        return {
          observation: "positive",
          feedbackNote: "ユーザーは前向きな関心を示した",
        };
      }
      return {
        kind: "exploit",
        targetDomain: "IT",
        targetTopic: "implementation",
        messageIntent: "最近の実装で役立ちそうな関連情報を短く共有する",
        reason: "実装話題への関心が高そうだから",
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
