import {
  InteractionLog,
  InteractionLogStore,
  TurnRecord,
  TurnRecordReader,
} from "../domain/types";

export interface PendingInteractionResolver {
  resolve(input: {
    botId: string;
    threadId: string;
    userId: string;
  }): Promise<string | null>;
}

export const createPendingInteractionResolver = (options: {
  turnRecordReader: TurnRecordReader;
  interactionLogStore: Pick<
    InteractionLogStore,
    "listRecentInteractionLogs"
  >;
  interactionLogLimit?: number;
  turnRecordLimit?: number;
  pendingTimeoutMs?: number;
  now?: () => Date;
}): PendingInteractionResolver => {
  const interactionLogLimit = positiveInteger(options.interactionLogLimit, 20);
  const turnRecordLimit = positiveInteger(options.turnRecordLimit, 64);
  const pendingTimeoutMs = Math.max(
    0,
    options.pendingTimeoutMs ?? 6 * 60 * 60 * 1000,
  );
  const now = options.now ?? (() => new Date());
  return {
    async resolve(input) {
      const [logs, turns] = await Promise.all([
        options.interactionLogStore.listRecentInteractionLogs({
          botId: input.botId,
          userId: input.userId,
          limit: interactionLogLimit,
        }),
        options.turnRecordReader.listRecentTurnRecords({
          botId: input.botId,
          threadId: input.threadId,
          limit: turnRecordLimit,
        }),
      ]);
      const nowMs = now().getTime();
      return (
        logs
          .filter((log) => log.threadId === input.threadId)
          .filter((log) => isActivePending(log, nowMs, pendingTimeoutMs))
          .sort(compareNewestFirst)
          .find((log) => awaitsHumanReaction(log, turns))?.id ?? null
      );
    },
  };
};

const awaitsHumanReaction = (
  log: InteractionLog,
  turns: TurnRecord[],
): boolean => {
  const linked = turns
    .filter((turn) => turn.sourceInteractionId === log.id)
    .sort((left, right) =>
      left.createdAtIso.localeCompare(right.createdAtIso),
    );
  if (log.trigger === "scheduled") {
    return (
      linked.some((turn) => turn.kind === "proactive") &&
      !linked.some((turn) => turn.kind === "human")
    );
  }
  const linkedHuman = linked.filter((turn) => turn.kind === "human");
  return linkedHuman.length === 1;
};

const isActivePending = (
  log: InteractionLog,
  nowMs: number,
  pendingTimeoutMs: number,
): boolean => {
  const pending =
    log.status === "pending" ||
    ((log.status === undefined || log.status === null) &&
      log.observation === "unknown");
  if (!pending) {
    return false;
  }
  const createdAtMs = Date.parse(log.createdAtIso);
  return (
    Number.isFinite(createdAtMs) &&
    (pendingTimeoutMs === 0 || nowMs - createdAtMs < pendingTimeoutMs)
  );
};

const compareNewestFirst = (left: InteractionLog, right: InteractionLog) =>
  right.createdAtIso.localeCompare(left.createdAtIso);

const positiveInteger = (value: number | undefined, fallback: number): number =>
  Math.max(1, Math.floor(value ?? fallback));
