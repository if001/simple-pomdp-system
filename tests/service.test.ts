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
  ScheduledAgentInput,
  DialoguePlanningModel,
  InteractionLog,
  InteractionLogStore,
  ProactiveContextSource,
  TurnRecord,
  TurnRecordReader,
  TopicStateSnapshot,
  TopicStateStore,
} from "../src/simple_pomdp/domain/types";

test("runTrigger applies a dialogue decision and enqueues a background instruction", async () => {
  const enqueued: ScheduledAgentInput[] = [];
  const service = createTestService({
    turnRecordReader: createInMemoryTurnRecordReader([
      userTurn("ao", "thread-1", "2026-06-14T00:00:00.000Z", "最近は実装の話題が多いです"),
    ]),
    topicStateStore: createInMemoryTopicStateStore(),
    interactionLogStore: createInMemoryInteractionLogStore(),
    backgroundInputSink: { enqueue: async (input) => enqueued.push(input) },
    now: () => new Date("2026-06-14T01:00:00.000Z"),
  });

  const dispatched = await runScheduled(service, {
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  assert.ok(dispatched);
  assert.equal(dispatched.trigger, "scheduled");
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.sourceInteractionId, dispatched.sourceInteractionId);
  assert.match(
    dispatched?.text ?? "",
    /これはユーザーからの入力ではなく、background からの介入指示です。/,
  );
});

test("conversation trigger returns one integration instruction without enqueueing", async () => {
  const enqueued: ScheduledAgentInput[] = [];
  const interactionLogStore = createInMemoryInteractionLogStore();
  const service = createTestService({
    turnRecordReader: createInMemoryTurnRecordReader(),
    topicStateStore: createInMemoryTopicStateStore(),
    interactionLogStore,
    backgroundInputSink: { enqueue: async (input) => enqueued.push(input) },
    now: () => new Date("2026-06-14T01:00:00.000Z"),
  });

  const output = await service.runTrigger({
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
    trigger: "conversation",
  });

  assert.ok(output);
  assert.equal(output.trigger, "conversation");
  assert.equal(enqueued.length, 0);
  assert.match(output.text, /次の話題を自然に統合/);
  const logs = await interactionLogStore.listRecentInteractionLogs({
    botId: "ao",
    userId: "discord-user",
    limit: 10,
  });
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.trigger, "conversation");
  assert.equal(logs[0]?.id, output.sourceInteractionId);
});

test("concurrent scheduled triggers share one dispatch", async () => {
  const enqueued: ScheduledAgentInput[] = [];
  const interactionLogStore = createInMemoryInteractionLogStore();
  const service = createTestService({
    turnRecordReader: createInMemoryTurnRecordReader(),
    topicStateStore: createInMemoryTopicStateStore(),
    interactionLogStore,
    backgroundInputSink: {
      enqueue: async (input) => {
        await Promise.resolve();
        enqueued.push(input);
      },
    },
    now: () => new Date("2026-06-14T01:00:00.000Z"),
  });
  const input = {
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  };

  const [first, second] = await Promise.all([
    runScheduled(service, input),
    runScheduled(service, input),
  ]);

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.sourceInteractionId, second.sourceInteractionId);
  assert.equal(enqueued.length, 1);
  const logs = await interactionLogStore.listRecentInteractionLogs({
    botId: "ao",
    userId: "discord-user",
    limit: 10,
  });
  assert.equal(logs.length, 1);
});

test("runTrigger loads injected proactive context sources with planner scope", async () => {
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
    topicStateStore: createInMemoryTopicStateStore(),
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

  await runScheduled(service, {
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

test("runTrigger passes an empty source context to the planner", async () => {
  let plannerPrompt = "";
  const fallback = createDefaultPlannerModel();
  const service = createTestService({
    turnRecordReader: createInMemoryTurnRecordReader(),
    topicStateStore: createInMemoryTopicStateStore(),
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

  await runScheduled(service, {
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  assert.match(plannerPrompt, /"proactiveContext":\[\]/);
});

test("runTrigger reports a proactive context source failure by name", async () => {
  const service = createTestService({
    turnRecordReader: createInMemoryTurnRecordReader(),
    topicStateStore: createInMemoryTopicStateStore(),
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
    runScheduled(service, {
      botId: "ao",
      threadId: "thread-1",
      userId: "discord-user",
    }),
    /Proactive context source "broken-user-memory" failed: database unavailable/,
  );
});

test("scheduled proactive positive reaction updates the linked InteractionLog", async () => {
  const interactionLogStore = createInMemoryInteractionLogStore();
  const topicStateStore = createInMemoryTopicStateStore();
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
    trigger: "scheduled",
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
    topicStateStore,
    interactionLogStore,
    now: () => new Date("2026-06-14T02:00:00.000Z"),
    plannerModel: {
      generateJson: async (_systemPrompt, userPrompt) =>
        userPrompt.includes("\"observedWindow\":")
          ? {
              observation: "positive",
              feedbackNote: "ユーザーは前向きな関心を示した",
            }
          : {
              kind: "refine",
              targetDomain: "IT",
              targetTopic: "implementation details",
              matchedExistingTopic: "implementation",
              messageIntent: "関心があった実装話題を少し掘り下げる",
              reason: "implementation が interested になったため",
            },
    },
  });

  const dispatched = await runScheduled(service, {
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  assert.ok(dispatched);
  assert.match(dispatched?.text ?? "", /判断種別: refine/);
  const state = await service.listTopicState({
    botId: "ao",
    userId: "discord-user",
  });
  assert.deepEqual(state?.topics, [
    {
      topic: "implementation",
      assessment: "interested",
      evidence: "ユーザーは前向きな関心を示した",
      lastTriedAt: "2026-06-14T00:00:00.000Z",
    },
  ]);
  const logs = await interactionLogStore.listRecentInteractionLogs({
    botId: "ao",
    userId: "discord-user",
    limit: 10,
  });
  assert.equal(logs[0]?.observation, "positive");
  assert.equal(logs[0]?.status, "resolved");
});

test("scheduled proactive continuation updates existing topic state", async () => {
  const interactionLogStore = createInMemoryInteractionLogStore();
  const topicStateStore = createInMemoryTopicStateStore({
    userId: "discord-user",
    topics: [
      {
        topic: "implementation",
        assessment: "possible",
        evidence: "以前は中立的な反応だった",
        lastTriedAt: "2026-06-14T00:00:00.000Z",
      },
    ],
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
    trigger: "scheduled",
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
    topicStateStore,
    interactionLogStore,
    now: () => new Date("2026-06-14T02:00:00.000Z"),
  });

  await runScheduled(service, {
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  const state = await service.listTopicState({
    botId: "ao",
    userId: "discord-user",
  });
  assert.equal(state?.topics.length, 1);
  assert.equal(state?.topics[0]?.topic, "implementation");
  assert.equal(state?.topics[0]?.assessment, "interested");
  assert.equal(state?.topics[0]?.evidence, "ユーザーは前向きな関心を示した");
});

test("scheduled proactive negative reaction updates the linked InteractionLog", async () => {
  const interactionLogStore = createInMemoryInteractionLogStore();
  await interactionLogStore.saveInteractionLog({
    id: "scheduled-negative",
    userId: "discord-user",
    botId: "ao",
    threadId: "thread-1",
    candidateKind: "explore",
    trigger: "scheduled",
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
    topicStateStore: createInMemoryTopicStateStore(),
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

  await runScheduled(service, {
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  const logs = await interactionLogStore.listRecentInteractionLogs({
    botId: "ao",
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
    trigger: "conversation",
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
          content: "最初の質問",
          timestampIso: "2026-06-14T01:03:00.000Z",
        },
        {
          role: "assistant",
          content: "通常回答へtestingの話題を統合した",
          timestampIso: "2026-06-14T01:03:01.000Z",
        },
      ],
    },
    {
      botId: "ao",
      threadId: "thread-1",
      kind: "human",
      sourceInteractionId: "conversation-log",
      createdAtIso: "2026-06-14T01:04:00.000Z",
      messages: [
        {
          role: "user",
          content: "その話題には興味がありません",
          timestampIso: "2026-06-14T01:04:00.000Z",
        },
        {
          role: "assistant",
          content: "assistant text must not become reaction evidence",
          timestampIso: "2026-06-14T01:04:01.000Z",
        },
      ],
    },
  ]);
  const fallbackPlanner = createDefaultPlannerModel();
  const service = createTestService({
    turnRecordReader,
    topicStateStore: createInMemoryTopicStateStore(),
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

  await runScheduled(service, {
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  assert.match(observedPrompt, /その話題には興味がありません/);
  assert.doesNotMatch(observedPrompt, /最初の質問/);
  assert.doesNotMatch(observedPrompt, /internal delegation/);
  assert.doesNotMatch(observedPrompt, /unrelated human/);
  assert.doesNotMatch(observedPrompt, /assistant text/);
  assert.doesNotMatch(planningPrompt, /internal delegation/);
  const logs = await interactionLogStore.listRecentInteractionLogs({
    botId: "ao",
    userId: "discord-user",
    limit: 10,
  });
  assert.equal(logs.find((log) => log.id === "conversation-log")?.observation, "negative");
});

test("no_response updates the InteractionLog without changing state", async () => {
  const interactionLogStore = createInMemoryInteractionLogStore();
  const initialState: TopicStateSnapshot = {
    userId: "discord-user",
    topics: [
      {
        topic: "testing",
        assessment: "interested",
        evidence: "ユーザーが前向きに反応した",
        lastTriedAt: "2026-06-14T00:00:00.000Z",
      },
    ],
    updatedAtIso: "2026-06-14T00:00:00.000Z",
  };
  const topicStateStore = createInMemoryTopicStateStore(initialState);
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
    trigger: "scheduled",
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
    topicStateStore,
    interactionLogStore,
    maxPendingInteractions: 10,
    pendingTimeoutMs: 60 * 60 * 1000,
    now: () => new Date("2026-06-14T02:00:00.000Z"),
  });

  await runScheduled(service, {
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  const state = await service.listTopicState({
    botId: "ao",
    userId: "discord-user",
  });
  assert.deepEqual(state, initialState);
  const logs = await interactionLogStore.listRecentInteractionLogs({
    botId: "ao",
    userId: "discord-user",
    limit: 10,
  });
  const expired = logs.find((log) => log.id === "log-2");
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.observation, "no_response");
});

test("runTrigger expires pending interaction after timeout even without enough turns", async () => {
  const interactionLogStore = createInMemoryInteractionLogStore();
  const topicStateStore = createInMemoryTopicStateStore();
  const turnRecordReader = createInMemoryTurnRecordReader([]);
  await interactionLogStore.saveInteractionLog({
    id: "log-3",
    userId: "discord-user",
    botId: "ao",
    threadId: "thread-1",
    candidateKind: "refine",
    trigger: "scheduled",
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
    topicStateStore,
    interactionLogStore,
    pendingTimeoutMs: 60 * 60 * 1000,
    maxPendingInteractions: 10,
    now: () => new Date("2026-06-14T02:00:00.000Z"),
  });

  await runScheduled(service, {
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  const logs = await interactionLogStore.listRecentInteractionLogs({
    botId: "ao",
    userId: "discord-user",
    limit: 10,
  });
  const expired = logs.find((log) => log.id === "log-3");
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.observation, "no_response");
  assert.equal(
    await service.listTopicState({ botId: "ao", userId: "discord-user" }),
    null,
  );
});

test("initial state falls back to an untried explore decision", async () => {
  const interactionLogStore = createInMemoryInteractionLogStore([
    {
      id: "log-previous",
      userId: "discord-user",
      botId: "ao",
      threadId: "thread-1",
      candidateKind: "exploit",
      trigger: "scheduled",
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
    topicStateStore: createInMemoryTopicStateStore(),
    interactionLogStore,
    initialDomainCandidates: ["music", "sports"],
    now: () => new Date("2026-06-14T04:00:00.000Z"),
    plannerModel: {
      generateJson: async (_systemPrompt, userPrompt) => {
        capturedPrompt = userPrompt;
        return {
          kind: "wait",
          reason: "invalid planner output",
        };
      },
    },
  });

  const dispatched = await runScheduled(service, {
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  assert.ok(dispatched);
  assert.match(dispatched?.text ?? "", /判断種別: explore/);
  assert.match(dispatched?.text ?? "", /領域: music/);
  assert.match(capturedPrompt, /"trigger":"scheduled"/);
  assert.doesNotMatch(capturedPrompt, /hoursSince|currentSituation|cooldown/);
  assert.match(capturedPrompt, /"proactiveContext":\[/);
  assert.match(capturedPrompt, /observation=no_response/);
  assert.match(capturedPrompt, /interaction at=2026-06-14T00:00:00.000Z/);
  const logs = await interactionLogStore.listRecentInteractionLogs({
    botId: "ao",
    userId: "discord-user",
    limit: 10,
  });
  assert.equal(logs.at(-1)?.candidateKind, "explore");
  assert.deepEqual(
    [...new Set(logs.map((log) => log.candidateKind))],
    ["exploit", "explore"],
  );
});

test("an avoided topic is rejected and replaced with an allowed explore", async () => {
  const service = createTestService({
    turnRecordReader: createInMemoryTurnRecordReader(),
    topicStateStore: createInMemoryTopicStateStore({
      userId: "discord-user",
      topics: [
        {
          topic: "baseball",
          assessment: "avoid",
          evidence: "ユーザーが興味はないと明示した",
          lastTriedAt: "2026-06-14T00:00:00.000Z",
        },
      ],
      updatedAtIso: "2026-06-14T00:00:00.000Z",
    }),
    interactionLogStore: createInMemoryInteractionLogStore(),
    initialDomainCandidates: ["music", "sports"],
    plannerModel: {
      generateJson: async () => ({
        kind: "exploit",
        targetDomain: "sports",
        targetTopic: "baseball",
        messageIntent: "野球の情報を再提示する",
        reason: "以前試したため",
      }),
    },
    now: () => new Date("2026-06-14T02:00:00.000Z"),
  });

  const dispatched = await runScheduled(service, {
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  assert.match(dispatched?.text ?? "", /判断種別: explore/);
  assert.match(dispatched?.text ?? "", /領域: music/);
  assert.doesNotMatch(dispatched?.text ?? "", /baseball/);
});

test.each([
  ["property testing", "プロパティベーステスト", "refine"],
  ["TypeScript", "typescript", "exploit"],
] as const)(
  "reuses canonical topic %s for the %s variant",
  async (canonicalTopic, proposedVariant, kind) => {
    const fixture = createTopicIdentityFixture({
      topic: canonicalTopic,
      assessment: "interested",
      decision: {
        kind,
        targetDomain: "engineering",
        targetTopic: proposedVariant,
        matchedExistingTopic: canonicalTopic,
        messageIntent: "既存話題を続ける",
        reason: "既存候補と意味的に一致する",
      },
    });

    const dispatched = await runScheduled(fixture.service, fixture.scope);
    const logs = await fixture.logs.listRecentInteractionLogs({
      botId: "ao",
      userId: "discord-user",
      limit: 10,
    });

    assert.match(dispatched?.text ?? "", new RegExp(`話題: ${canonicalTopic}`));
    assert.equal(logs.at(-1)?.targetTopic, canonicalTopic);
    assert.equal(fixture.plannerCalls(), 1);
    assert.deepEqual(fixture.topicCandidates(), [canonicalTopic]);
  },
);

test("does not explore an avoided topic through a semantic paraphrase", async () => {
  const fixture = createTopicIdentityFixture({
    topic: "野球",
    assessment: "avoid",
    initialDomainCandidates: ["baseball", "music"],
    decision: {
      kind: "explore",
      targetDomain: "baseball",
      targetTopic: "baseball",
      matchedExistingTopic: "野球",
      messageIntent: "野球を英語表記で尋ねる",
      reason: "既存のavoid話題と言い換え関係にある",
    },
  });

  const dispatched = await runScheduled(fixture.service, fixture.scope);

  assert.match(dispatched?.text ?? "", /領域: music/);
  assert.doesNotMatch(dispatched?.text ?? "", /baseball|野球/);
  assert.equal(fixture.plannerCalls(), 1);
});

test("accepts a genuinely unknown topic as explore", async () => {
  const fixture = createTopicIdentityFixture({
    topic: "testing",
    assessment: "possible",
    decision: {
      kind: "explore",
      targetDomain: "music",
      targetTopic: "ambient music",
      messageIntent: "未知の音楽嗜好を尋ねる",
      reason: "既存候補と意味的に異なる",
    },
  });

  const dispatched = await runScheduled(fixture.service, fixture.scope);

  assert.match(dispatched?.text ?? "", /話題: ambient music/);
  assert.equal(fixture.plannerCalls(), 1);
});

test("falls back to an untried domain for invalid matchedExistingTopic", async () => {
  const fixture = createTopicIdentityFixture({
    topic: "testing",
    assessment: "possible",
    initialDomainCandidates: ["sports", "music"],
    decision: {
      kind: "refine",
      targetDomain: "sports",
      targetTopic: "baseball",
      matchedExistingTopic: "not-a-candidate",
      messageIntent: "不正候補を使う",
      reason: "候補外match",
    },
  });

  const dispatched = await runScheduled(fixture.service, fixture.scope);

  assert.match(dispatched?.text ?? "", /判断種別: explore/);
  assert.match(dispatched?.text ?? "", /領域: music/);
  assert.equal(fixture.plannerCalls(), 1);
});

test("runTrigger uses exploit research result in instruction and interaction log", async () => {
  const enqueued: ScheduledAgentInput[] = [];
  const interactionLogStore = createInMemoryInteractionLogStore();
  const service = createTestService({
    turnRecordReader: createInMemoryTurnRecordReader([
      userTurn("ao", "thread-1", "2026-06-14T00:00:00.000Z", "TypeScript 最近どう？"),
    ]),
    topicStateStore: createInMemoryTopicStateStore({
      userId: "discord-user",
      topics: [
        {
          topic: "implementation",
          assessment: "interested",
          evidence: "ユーザーが実装の話題に前向きだった",
        },
      ],
      updatedAtIso: "2026-06-14T00:00:00.000Z",
    }),
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

  await runScheduled(service, {
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  });

  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0]?.text ?? "", /調査結果: TypeScript の新しい更新点/);
  assert.match(enqueued[0]?.text ?? "", /articleIds: article_1/);
  const logs = await interactionLogStore.listRecentInteractionLogs({
    botId: "ao",
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
      topicStateReader: options.topicStateStore,
      interactionLogReader: options.interactionLogStore,
    }),
  ];
  return createSimplePomdpSystemService({
    ...options,
    contextSources,
    plannerModel: options.plannerModel ?? createDefaultPlannerModel(),
  });
}

function createTopicIdentityFixture(input: {
  topic: string;
  assessment: TopicStateSnapshot["topics"][number]["assessment"];
  decision: DialogueDecision;
  initialDomainCandidates?: string[];
}) {
  let calls = 0;
  let candidates: string[] = [];
  const logs = createInMemoryInteractionLogStore();
  const scope = {
    botId: "ao",
    threadId: "thread-1",
    userId: "discord-user",
  };
  const service = createTestService({
    turnRecordReader: createInMemoryTurnRecordReader(),
    topicStateStore: createInMemoryTopicStateStore({
      userId: scope.userId,
      topics: [
        {
          topic: input.topic,
          assessment: input.assessment,
          evidence: "fixture evidence",
        },
      ],
      updatedAtIso: "2026-09-02T00:00:00.000Z",
    }),
    interactionLogStore: logs,
    initialDomainCandidates: input.initialDomainCandidates ?? ["music"],
    plannerModel: {
      generateJson: async (_systemPrompt, userPrompt) => {
        calls += 1;
        const parsed = JSON.parse(userPrompt) as {
          topicCandidates: Array<{ topic: string }>;
        };
        candidates = parsed.topicCandidates.map(({ topic }) => topic);
        return input.decision;
      },
    },
    now: () => new Date("2026-09-02T01:00:00.000Z"),
  });
  return {
    service,
    logs,
    scope,
    plannerCalls: () => calls,
    topicCandidates: () => candidates,
  };
}

const runScheduled = (
  service: ReturnType<typeof createSimplePomdpSystemService>,
  input: { botId: string; threadId: string; userId: string },
) => service.runTrigger({ ...input, trigger: "scheduled" });

function createDefaultPlannerModel(): DialoguePlanningModel {
  return {
    generateJson: async (_systemPrompt, userPrompt) => {
      if (userPrompt.includes("\"message\":") && userPrompt.includes("\"observedWindow\":")) {
        return {
          observation: "positive",
          feedbackNote: "ユーザーは前向きな関心を示した",
        };
      }
      const parsed = JSON.parse(userPrompt) as {
        topicCandidates?: Array<{ topic: string }>;
      };
      const matchedExistingTopic = parsed.topicCandidates?.[0]?.topic;
      return {
        kind: "exploit",
        targetDomain: "IT",
        targetTopic: "implementation",
        ...(matchedExistingTopic ? { matchedExistingTopic } : {}),
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

function createInMemoryTopicStateStore(
  initial: TopicStateSnapshot | null = null,
): TopicStateStore {
  let item = initial;
  return {
    getTopicState: async () => item,
    saveTopicState: async ({ state }) => {
      item = state;
    },
  };
}

function createInMemoryInteractionLogStore(
  initial: InteractionLog[] = [],
): InteractionLogStore {
  const items = [...initial];
  return {
    listRecentInteractionLogs: async ({ botId, userId, limit }) =>
      items
        .filter((log) => log.botId === botId && log.userId === userId)
        .slice(-limit),
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
