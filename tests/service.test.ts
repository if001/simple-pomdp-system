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
    topicLabel: "implementation",
    message: "実装に関する補足を共有したい",
    observation: "unknown",
    feedbackNote: "",
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
  assert.equal(belief?.topics[0]?.label, "implementation");
  assert.equal(belief?.topics[0]?.interest, 1);
  const logs = await interactionLogStore.listRecentInteractionLogs({
    userId: "discord-user",
    limit: 10,
  });
  assert.equal(logs[0]?.observation, "positive");
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
              topicLabel: "implementation",
              topicSummary: "実装の話題への関心がありそう",
              interestDelta: 1,
              confidenceDelta: 1,
              initiationToleranceDelta: 0,
              note: "明示的に関心を示した",
            },
          ],
        };
      }
      if (userPrompt.includes("\"message\":") && userPrompt.includes("\"userReplies\":")) {
        return {
          observation: "positive",
          feedbackNote: "ユーザーは前向きな関心を示した",
        };
      }
      return {
        candidates: [
          {
            kind: "exploit",
            topicLabel: "implementation",
            intent: "最近の実装に近い話題を短く補足する",
            draftMessage: "最近の実装で役立ちそうな関連情報を短く共有したいです。",
            value: "high",
            infoGain: "medium",
            cost: "low",
            reason: "実装話題への関心が高そうだから",
          },
          {
            kind: "do_nothing",
            intent: "今は何もしない",
            value: "low",
            infoGain: "low",
            cost: "low",
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
