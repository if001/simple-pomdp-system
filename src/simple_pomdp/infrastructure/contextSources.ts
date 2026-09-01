import {
  InteractionLogStore,
  ProactiveContextSource,
  TurnRecord,
  TurnRecordReader,
  UserBeliefStore,
  UserMemoryReader,
} from "../domain/types";

interface ContextLimitOptions {
  limit?: number;
  maxItemLength?: number;
}

export const createRecentTurnContextSource = (options: {
  reader: TurnRecordReader;
} & ContextLimitOptions): ProactiveContextSource => {
  const limit = positiveInteger(options.limit, 12);
  const maxItemLength = positiveInteger(options.maxItemLength, 360);
  return {
    name: "recent-turn-records",
    async load(input) {
      const turns = await options.reader.listRecentTurnRecords({
        botId: input.botId,
        threadId: input.threadId,
        limit,
      });
      return turns
        .slice(-limit)
        .filter((turn) => turn.kind !== "delegation")
        .map((turn) =>
          compact(
            `[turn kind=${turn.kind} at=${turn.createdAtIso}] ${formatTurn(turn)}`,
            maxItemLength,
          ),
        );
    },
  };
};

export const createUserMemoryContextSource = (options: {
  reader: UserMemoryReader;
} & ContextLimitOptions): ProactiveContextSource => {
  const limit = positiveInteger(options.limit, 8);
  const maxItemLength = positiveInteger(options.maxItemLength, 280);
  return {
    name: "user-memory",
    async load(input) {
      const items = await options.reader.listRecentUserMemory({
        botId: input.botId,
        userId: input.userId,
        limit,
      });
      return items
        .slice(0, limit)
        .map((item) => compact(`[user-memory] ${item.text}`, maxItemLength))
        .filter((item) => item !== "[user-memory]");
    },
  };
};

export const createTopicStateInteractionLogContextSource = (options: {
  userBeliefReader: Pick<UserBeliefStore, "getUserBelief">;
  interactionLogReader: Pick<InteractionLogStore, "listRecentInteractionLogs">;
} & ContextLimitOptions): ProactiveContextSource => {
  const limit = positiveInteger(options.limit, 12);
  const maxItemLength = positiveInteger(options.maxItemLength, 360);
  return {
    name: "topic-state-interaction-log",
    async load(input) {
      const [belief, logs] = await Promise.all([
        options.userBeliefReader.getUserBelief(input.userId),
        options.interactionLogReader.listRecentInteractionLogs({
          userId: input.userId,
          limit,
        }),
      ]);
      const topicContext = (belief?.topics ?? []).slice(-limit).map((topic) =>
        compact(
          `[topic-state] domain=${topic.domain}${topic.topic ? ` topic=${topic.topic}` : ""} interest=${topic.interest} confidence=${topic.confidence}`,
          maxItemLength,
        ),
      );
      const interactionContext = logs
        .filter(
          (log) =>
            log.botId === input.botId && log.threadId === input.threadId,
        )
        .slice(-limit)
        .map((log) =>
          compact(
            `[interaction at=${log.createdAtIso}] kind=${log.candidateKind}${log.targetDomain ? ` domain=${log.targetDomain}` : ""}${log.targetTopic ? ` topic=${log.targetTopic}` : ""} observation=${log.observation} message=${log.message}${log.feedbackNote ? ` feedback=${log.feedbackNote}` : ""}`,
            maxItemLength,
          ),
        );
      return [...topicContext, ...interactionContext].slice(-limit);
    },
  };
};

const formatTurn = (turn: TurnRecord): string =>
  turn.messages
    .filter((message) => {
      if (turn.kind === "delegation") {
        return false;
      }
      return turn.kind === "proactive"
        ? message.role === "assistant"
        : message.role === "user" || message.role === "assistant";
    })
    .map((message) => `[${message.role}] ${message.content}`)
    .join(" ");

const compact = (value: string, maxLength: number): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
};

const positiveInteger = (value: number | undefined, fallback: number): number =>
  Math.max(1, Math.floor(value ?? fallback));
