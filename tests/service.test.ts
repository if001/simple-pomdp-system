import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createSimplePomdpSystemService,
  type SimplePomdpSystemOptions,
} from "../src/simple_pomdp/api/service";
import {
  createRecentTurnContextSource,
  createTopicStateInteractionLogContextSource,
  createUserMemoryContextSource,
} from "../src/simple_pomdp/infrastructure/contextSources";
import {
  BackgroundInput,
  DialoguePlanningModel,
  InteractionLog,
  InteractionLogStore,
  ProactiveContextSource,
  TurnRecord,
  TurnRecordReader,
  UserBelief,
  UserBeliefStore,
} from "../src/simple_pomdp/domain/types";

test("dispatchNext applies a dialogue decision and enqueues a background instruction", async () => {
  const enqueued: BackgroundInput[] = [];
  const service = createTestService({
    turnRecordReader: createInMemoryTurnRecordReader([
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

test("dispatchNext loads injected proactive context sources with planner scope", async () => {
  const calls: Array<{ botId: string; threadId: string; userId: string }> = [];
  let plannerPrompt = "";
  const source: ProactiveContextSource = {
    name: "fake-source",
    load: async (input) => {
      calls.push(input);
      return ["fake context item"];
    },
  };
  const fallback = createDefaultPlannerModel();
  const service = createTestService({
    turnRecordReader: createInMemoryTurnRecordReader(),
    userBeliefStore: createInMemoryUserBeliefStore(),
    interactionLogStore: createInMemoryInteractionLogStore(),
    contextSources: [source],
    plannerModel: {
      generateJson: async (systemPrompt, userPrompt) => {
        plannerPrompt = userPrompt;
        return fallback.generateJson(systemPrompt, userPrompt);
      },
    },
    now: () => new Date("2026-06-14T01:00:00.000Z"),
  });

  await service.dispatchNext({
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  assert.deepEqual(calls, [
    { botId: "ao", threadId: "thread-1", userId: "discord-user" },
  ]);
  assert.match(plannerPrompt, /fake context item/);
  assert.doesNotMatch(plannerPrompt, /userBeliefSummary/);
  assert.deepEqual(Object.keys(source).sort(), ["load", "name"]);
});

test("dispatchNext passes an empty source context to the planner", async () => {
  let plannerPrompt = "";
  const fallback = createDefaultPlannerModel();
  const service = createTestService({
    turnRecordReader: createInMemoryTurnRecordReader(),
    userBeliefStore: createInMemoryUserBeliefStore(),
    interactionLogStore: createInMemoryInteractionLogStore(),
    contextSources: [{ name: "empty", load: async () => [] }],
    plannerModel: {
      generateJson: async (systemPrompt, userPrompt) => {
        plannerPrompt = userPrompt;
        return fallback.generateJson(systemPrompt, userPrompt);
      },
    },
    now: () => new Date("2026-06-14T01:00:00.000Z"),
  });

  await service.dispatchNext({
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  assert.match(plannerPrompt, /"proactiveContext":\[\]/);
});

test("dispatchNext reports a proactive context source failure by name", async () => {
  const service = createTestService({
    turnRecordReader: createInMemoryTurnRecordReader(),
    userBeliefStore: createInMemoryUserBeliefStore(),
    interactionLogStore: createInMemoryInteractionLogStore(),
    contextSources: [
      {
        name: "broken-user-memory",
        load: async () => {
          throw new Error("database unavailable");
        },
      },
    ],
    now: () => new Date("2026-06-14T01:00:00.000Z"),
  });

  await assert.rejects(
    service.dispatchNext({
      botId: "ao",
      threadId: "thread-1",
      userId: "discord-user",
    }),
    /Proactive context source "broken-user-memory" failed: database unavailable/,
  );
});

test("scheduled proactive positive reaction updates the linked InteractionLog", async () => {
  const interactionLogStore = createInMemoryInteractionLogStore();
  const userBeliefStore = createInMemoryUserBeliefStore();
  const turnRecordReader = createInMemoryTurnRecordReader([
    assistantTurn("ao", "thread-1", "2026-06-14T00:00:00.000Z", "最初の補足です。", "log-1"),
    userTurn("ao", "thread-1", "2026-06-14T00:01:00.000Z", "その方向はかなり興味があります", "log-1"),
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
    turnRecordReader,
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

test("scheduled proactive continuation updates existing topic belief", async () => {
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
  const turnRecordReader = createInMemoryTurnRecordReader([
    assistantTurn("ao", "thread-1", "2026-06-14T01:00:00.000Z", "補足です。", "log-existing"),
    userTurn("ao", "thread-1", "2026-06-14T01:01:00.000Z", "それは引き続き気になります", "log-existing"),
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
    turnRecordReader,
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

test("scheduled proactive negative reaction updates the linked InteractionLog", async () => {
  const interactionLogStore = createInMemoryInteractionLogStore();
  await interactionLogStore.saveInteractionLog({
    id: "scheduled-negative",
    userId: "discord-user",
    botId: "ao",
    threadId: "thread-1",
    candidateKind: "explore",
    targetDomain: "sports",
    targetTopic: "baseball",
    message: "野球の話題を共有する",
    status: "pending",
    observation: "unknown",
    feedbackNote: "",
    observeWindowTurns: 2,
    createdAtIso: "2026-06-14T01:00:00.000Z",
  });
  const fallbackPlanner = createDefaultPlannerModel();
  const service = createTestService({
    turnRecordReader: createInMemoryTurnRecordReader([
      assistantTurn(
        "ao",
        "thread-1",
        "2026-06-14T01:00:01.000Z",
        "野球の話題です",
        "scheduled-negative",
      ),
      userTurn(
        "ao",
        "thread-1",
        "2026-06-14T01:01:00.000Z",
        "その話題は興味がありません",
        "scheduled-negative",
      ),
    ]),
    userBeliefStore: createInMemoryUserBeliefStore(),
    interactionLogStore,
    now: () => new Date("2026-06-14T02:00:00.000Z"),
    plannerModel: {
      generateJson: async (systemPrompt, userPrompt) =>
        userPrompt.includes("\"observedWindow\":")
          ? {
              observation: "negative",
              feedbackNote: "ユーザーは明示的に否定した",
            }
          : fallbackPlanner.generateJson(systemPrompt, userPrompt),
    },
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
  assert.equal(logs.find((log) => log.id === "scheduled-negative")?.observation, "negative");
});

test("conversation-trigger reaction uses only the linked human user evidence", async () => {
  const interactionLogStore = createInMemoryInteractionLogStore();
  let observedPrompt = "";
  let planningPrompt = "";
  await interactionLogStore.saveInteractionLog({
    id: "conversation-log",
    userId: "discord-user",
    botId: "ao",
    threadId: "thread-1",
    candidateKind: "refine",
    targetDomain: "IT",
    targetTopic: "testing",
    message: "テストの話題を続ける",
    status: "pending",
    observation: "unknown",
    feedbackNote: "",
    observeWindowTurns: 2,
    createdAtIso: "2026-06-14T01:00:00.000Z",
  });
  const turnRecordReader = createInMemoryTurnRecordReader([
    {
      botId: "ao",
      threadId: "thread-1",
      kind: "delegation",
      sourceInteractionId: "conversation-log",
      createdAtIso: "2026-06-14T01:01:00.000Z",
      messages: [
        {
          role: "user",
          content: "internal delegation must be ignored",
          timestampIso: "2026-06-14T01:01:00.000Z",
        },
      ],
    },
    userTurn(
      "ao",
      "thread-1",
      "2026-06-14T01:02:00.000Z",
      "unrelated human must be ignored",
      "other-log",
    ),
    {
      botId: "ao",
      threadId: "thread-1",
      kind: "human",
      sourceInteractionId: "conversation-log",
      createdAtIso: "2026-06-14T01:03:00.000Z",
      messages: [
        {
          role: "user",
          content: "その話題には興味がありません",
          timestampIso: "2026-06-14T01:03:00.000Z",
        },
        {
          role: "assistant",
          content: "assistant text must not become reaction evidence",
          timestampIso: "2026-06-14T01:03:01.000Z",
        },
      ],
    },
  ]);
  const fallbackPlanner = createDefaultPlannerModel();
  const service = createTestService({
    turnRecordReader,
    userBeliefStore: createInMemoryUserBeliefStore(),
    interactionLogStore,
    now: () => new Date("2026-06-14T02:00:00.000Z"),
    plannerModel: {
      generateJson: async (systemPrompt, userPrompt) => {
        if (userPrompt.includes("\"observedWindow\":")) {
          observedPrompt = userPrompt;
          return {
            observation: "negative",
            feedbackNote: "ユーザーは明示的に否定した",
          };
        }
        planningPrompt = userPrompt;
        return fallbackPlanner.generateJson(systemPrompt, userPrompt);
      },
    },
  });

  await service.dispatchNext({
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  assert.match(observedPrompt, /その話題には興味がありません/);
  assert.doesNotMatch(observedPrompt, /internal delegation/);
  assert.doesNotMatch(observedPrompt, /unrelated human/);
  assert.doesNotMatch(observedPrompt, /assistant text/);
  assert.doesNotMatch(planningPrompt, /internal delegation/);
  const logs = await interactionLogStore.listRecentInteractionLogs({
    userId: "discord-user",
    limit: 10,
  });
  assert.equal(logs.find((log) => log.id === "conversation-log")?.observation, "negative");
});

test("no_response updates the InteractionLog without changing belief", async () => {
  const interactionLogStore = createInMemoryInteractionLogStore();
  const initialBelief: UserBelief = {
    userId: "discord-user",
    topics: [
      {
        id: "topic_IT_testing",
        domain: "IT",
        topic: "testing",
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
  };
  const userBeliefStore = createInMemoryUserBeliefStore(initialBelief);
  const turnRecordReader = createInMemoryTurnRecordReader([
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
    turnRecordReader,
    userBeliefStore,
    interactionLogStore,
    maxPendingInteractions: 10,
    pendingTimeoutMs: 60 * 60 * 1000,
    now: () => new Date("2026-06-14T02:00:00.000Z"),
  });

  await service.dispatchNext({
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  const belief = await service.listUserBelief({ userId: "discord-user" });
  assert.deepEqual(belief, initialBelief);
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
  const turnRecordReader = createInMemoryTurnRecordReader([]);
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
    turnRecordReader,
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
  assert.equal(await service.listUserBelief({ userId: "discord-user" }), null);
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
  const turnRecordReader = createInMemoryTurnRecordReader([
    userTurn("ao", "thread-1", "2026-06-14T01:00:00.000Z", "こんにちは"),
  ]);
  let capturedPrompt = "";
  const service = createTestService({
    turnRecordReader,
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
  assert.match(capturedPrompt, /"proactiveContext":\[/);
  assert.match(capturedPrompt, /observation=no_response/);
  assert.match(capturedPrompt, /interaction at=2026-06-14T00:00:00.000Z/);
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
    turnRecordReader: createInMemoryTurnRecordReader([
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
    turnRecordReader: createInMemoryTurnRecordReader([
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
  options: Omit<
    SimplePomdpSystemOptions,
    "plannerModel" | "contextSources"
  > & {
    plannerModel?: DialoguePlanningModel;
    contextSources?: ProactiveContextSource[];
  },
) {
  const contextSources = options.contextSources ?? [
    createRecentTurnContextSource({ reader: options.turnRecordReader }),
    createUserMemoryContextSource({
      reader: { listRecentUserMemory: async () => [] },
    }),
    createTopicStateInteractionLogContextSource({
      userBeliefReader: options.userBeliefStore,
      interactionLogReader: options.interactionLogStore,
    }),
  ];
  return createSimplePomdpSystemService({
    ...options,
    contextSources,
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

function createInMemoryTurnRecordReader(initial: TurnRecord[] = []): TurnRecordReader {
  const items = [...initial];
  return {
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
  sourceInteractionId?: string,
): TurnRecord {
  return {
    botId,
    threadId,
    kind: "human",
    ...(sourceInteractionId ? { sourceInteractionId } : {}),
    createdAtIso,
    messages: [{ role: "user", content, timestampIso: createdAtIso }],
  };
}

function assistantTurn(
  botId: string,
  threadId: string,
  createdAtIso: string,
  content: string,
  sourceInteractionId?: string,
): TurnRecord {
  return {
    botId,
    threadId,
    kind: "proactive",
    ...(sourceInteractionId ? { sourceInteractionId } : {}),
    createdAtIso,
    messages: [{ role: "assistant", content, timestampIso: createdAtIso }],
  };
}
