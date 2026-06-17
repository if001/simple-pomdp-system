import {
  BackgroundInput,
  BackgroundInputSink,
  BeliefUpdate,
  DialogueCandidate,
  DialoguePlanningModel,
  InteractionLog,
  InteractionLogStore,
  InteractionObservation,
  PomdpContextProvider,
  TurnRecord,
  TurnRecordStore,
  UserBelief,
  UserBeliefStore,
  TopicBelief,
  InitiationTolerance,
} from "../domain/types";

export interface SimplePomdpSystemService {
  ingestTurnRecord(input: TurnRecord): Promise<void>;
  listUserBelief(input: { userId: string }): Promise<UserBelief | null>;
  dispatchNext(input: {
    botId: string;
    threadId: string;
    userId: string;
  }): Promise<BackgroundInput[]>;
}

export interface SimplePomdpSystemOptions {
  turnRecordStore: TurnRecordStore;
  userBeliefStore: UserBeliefStore;
  interactionLogStore: InteractionLogStore;
  plannerModel: DialoguePlanningModel;
  backgroundInputSink?: BackgroundInputSink;
  contextProvider?: PomdpContextProvider;
  recentTurnLimit?: number;
  interactionLogLimit?: number;
  observeWindowTurns?: number;
  dispatchCooldownMs?: number;
  maxPendingInteractions?: number;
  now?: () => Date;
}

interface CandidatePlanningResult {
  candidates?: DialogueCandidate[];
  selectedIndex?: number;
}

interface ObservationResult {
  observation?: InteractionObservation;
  feedbackNote?: string;
}

interface BeliefUpdateResult {
  updates?: Array<{
    topicLabel?: string;
    topicSummary?: string;
    interestDelta?: -1 | 0 | 1 | number;
    confidenceDelta?: -1 | 0 | 1 | number;
    initiationToleranceDelta?: -1 | 0 | 1 | number;
    note?: string;
  }>;
}

class DefaultSimplePomdpSystemService implements SimplePomdpSystemService {
  private readonly recentTurnLimit: number;
  private readonly interactionLogLimit: number;
  private readonly observeWindowTurns: number;
  private readonly dispatchCooldownMs: number;
  private readonly maxPendingInteractions: number;
  private readonly now: () => Date;

  constructor(private readonly options: SimplePomdpSystemOptions) {
    this.recentTurnLimit = Math.max(1, options.recentTurnLimit ?? 12);
    this.interactionLogLimit = Math.max(1, options.interactionLogLimit ?? 20);
    this.observeWindowTurns = Math.max(1, options.observeWindowTurns ?? 3);
    this.dispatchCooldownMs = Math.max(0, options.dispatchCooldownMs ?? 60 * 60 * 1000);
    this.maxPendingInteractions = Math.max(1, options.maxPendingInteractions ?? 1);
    this.now = options.now ?? (() => new Date());
  }

  async ingestTurnRecord(input: TurnRecord): Promise<void> {
    await this.options.turnRecordStore.appendTurnRecord(input);
  }

  async listUserBelief(input: { userId: string }): Promise<UserBelief | null> {
    return this.options.userBeliefStore.getUserBelief(input.userId);
  }

  async dispatchNext(input: {
    botId: string;
    threadId: string;
    userId: string;
  }): Promise<BackgroundInput[]> {
    await this.refreshBeliefFromPendingInteractions(input);

    const belief =
      (await this.options.userBeliefStore.getUserBelief(input.userId)) ??
      createDefaultBelief(input.userId, this.now().toISOString());
    const interactionLogs = await this.options.interactionLogStore.listRecentInteractionLogs({
      userId: input.userId,
      limit: this.interactionLogLimit,
    });
    const pendingLogs = interactionLogs.filter(
      (log) =>
        log.botId === input.botId &&
        log.threadId === input.threadId &&
        log.observation === "unknown",
    );
    if (pendingLogs.length >= this.maxPendingInteractions) {
      return [];
    }
    const latestInteraction = [...interactionLogs]
      .filter((log) => log.botId === input.botId && log.threadId === input.threadId)
      .sort((left, right) => Date.parse(right.createdAtIso) - Date.parse(left.createdAtIso))[0];
    if (
      latestInteraction &&
      this.now().getTime() - Date.parse(latestInteraction.createdAtIso) <
        this.dispatchCooldownMs
    ) {
      return [];
    }

    const recentTurns = await this.options.turnRecordStore.listRecentTurnRecords({
      botId: input.botId,
      threadId: input.threadId,
      limit: this.recentTurnLimit,
    });
    const context = this.options.contextProvider
      ? await this.options.contextProvider.getContext(input)
      : {};
    const planning = await this.planCandidates({
      belief,
      recentTurns,
      interactionLogs: interactionLogs.slice(-this.interactionLogLimit),
      context,
    });
    const selected = selectCandidate(planning);
    if (!selected || selected.kind === "do_nothing") {
      return [];
    }

    const interactionId = `pomdp_${sanitize(input.userId)}_${this.now().toISOString()}`;
    const backgroundInput: BackgroundInput = {
      botId: input.botId,
      threadId: input.threadId,
      text: buildBackgroundInstruction(selected),
      sourceInteractionId: interactionId,
    };
    if (this.options.backgroundInputSink) {
      await this.options.backgroundInputSink.enqueue(backgroundInput);
    }
    await this.options.interactionLogStore.saveInteractionLog({
      id: interactionId,
      userId: input.userId,
      botId: input.botId,
      threadId: input.threadId,
      candidateKind: selected.kind,
      ...(selected.topicLabel ? { topicLabel: selected.topicLabel } : {}),
      message: selected.draftMessage?.trim() || selected.intent.trim(),
      observation: "unknown",
      feedbackNote: "",
      createdAtIso: this.now().toISOString(),
    });
    process.stdout.write(
      `[simple-pomdp] dispatched botId=${input.botId} threadId=${input.threadId} candidate=${selected.kind}${selected.topicLabel ? ` topic=${selected.topicLabel}` : ""}\n`,
    );
    return [backgroundInput];
  }

  private async refreshBeliefFromPendingInteractions(input: {
    botId: string;
    threadId: string;
    userId: string;
  }): Promise<void> {
    const logs = await this.options.interactionLogStore.listRecentInteractionLogs({
      userId: input.userId,
      limit: this.interactionLogLimit,
    });
    const pending = logs.filter(
      (log) =>
        log.botId === input.botId &&
        log.threadId === input.threadId &&
        log.observation === "unknown",
    );
    if (pending.length === 0) {
      return;
    }
    const belief =
      (await this.options.userBeliefStore.getUserBelief(input.userId)) ??
      createDefaultBelief(input.userId, this.now().toISOString());
    const turns = await this.options.turnRecordStore.listRecentTurnRecords({
      botId: input.botId,
      threadId: input.threadId,
      limit: this.recentTurnLimit + this.observeWindowTurns + 2,
    });
    for (const log of pending) {
      const observation = await observeInteraction(
        this.options.plannerModel,
        log,
        turns,
        this.observeWindowTurns,
      );
      if (observation.kind === "pending") {
        continue;
      }
      const completedLog: InteractionLog = {
        ...log,
        observation: observation.observation,
        feedbackNote: observation.feedbackNote,
        completedAtIso: this.now().toISOString(),
      };
      await this.options.interactionLogStore.saveInteractionLog(completedLog);
      const updates = await inferBeliefUpdates(
        this.options.plannerModel,
        belief,
        completedLog,
      );
      const nextBelief = applyBeliefUpdates(
        belief,
        updates,
        log.id,
        this.now().toISOString(),
      );
      await this.options.userBeliefStore.saveUserBelief(nextBelief);
    }
  }

  private async planCandidates(input: {
    belief: UserBelief;
    recentTurns: TurnRecord[];
    interactionLogs: InteractionLog[];
    context: {
      recentContextSummary?: string;
      notes?: string[];
    };
  }): Promise<CandidatePlanningResult> {
    return this.options.plannerModel.generateJson<CandidatePlanningResult>(
      [
        "あなたは simple POMDP ベースの proactive dialogue planner です。",
        "belief をもとに、agent からユーザーへ話しかける候補を 3 から 5 個作ってください。",
        "候補には exploit, refine, explore, do_nothing を使えます。",
        "do_nothing は必ず 1 つ含めてください。",
        "各 candidate には kind, topicLabel, intent, draftMessage, value, infoGain, cost, reason を入れてください。",
        "その後、今出す価値がコストを上回る候補を 1 つ選び、selectedIndex で返してください。",
        "直近で agent から話しかけたばかりなら do_nothing を選びやすくしてください。",
        "JSON のみを返してください。",
      ].join(" "),
      JSON.stringify({
        instruction: [
          "userBelief, recentTurns, recentInteractionLogs, optionalContext を読んでください。",
          "候補を 3 から 5 個作ってください。",
          "候補が弱い場合でも do_nothing を含めてください。",
          "次の shape で返してください:",
          "- candidates: DialogueCandidate[]",
          "- selectedIndex: number",
        ].join(" "),
        userBelief: input.belief,
        recentTurns: formatRecentTurns(input.recentTurns),
        recentInteractionLogs: input.interactionLogs.map((log) => ({
          candidateKind: log.candidateKind,
          topicLabel: log.topicLabel,
          message: log.message,
          observation: log.observation,
          feedbackNote: log.feedbackNote,
          createdAtIso: log.createdAtIso,
        })),
        optionalContext: {
          recentContextSummary: input.context.recentContextSummary ?? "",
          notes: input.context.notes ?? [],
        },
      }),
    );
  }
}

export const createSimplePomdpSystemService = (
  options: SimplePomdpSystemOptions,
): SimplePomdpSystemService => new DefaultSimplePomdpSystemService(options);

const observeInteraction = async (
  plannerModel: DialoguePlanningModel,
  log: InteractionLog,
  turns: TurnRecord[],
  observeWindowTurns: number,
): Promise<
  | { kind: "pending" }
  | {
      kind: "resolved";
      observation: InteractionObservation;
      feedbackNote: string;
    }
> => {
  const interactionAt = Date.parse(log.createdAtIso);
  const subsequentTurns = turns.filter(
    (turn) => Date.parse(turn.createdAtIso) > interactionAt,
  );
  const observedTurns = subsequentTurns.slice(0, observeWindowTurns);
  const userReplies = observedTurns
    .flatMap((turn) => turn.messages)
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);
  if (userReplies.length === 0 && subsequentTurns.length < observeWindowTurns) {
    return { kind: "pending" };
  }
  if (userReplies.length === 0) {
    return {
      kind: "resolved",
      observation: "no_response",
      feedbackNote: "観測窓内に明示的な反応はなかった。",
    };
  }
  const parsed = await plannerModel.generateJson<ObservationResult>(
    [
      "あなたは、agent からの自発的な話しかけに対するユーザー反応を分類します。",
      "message は agent がユーザーへ伝えた内容です。",
      "userReplies はその後のユーザー応答です。",
      "observation は positive, negative, neutral, no_response, unknown のいずれかです。",
      "feedbackNote には短い自然言語の説明を返してください。",
      "JSON のみを返してください。",
    ].join(" "),
    JSON.stringify({
      instruction: [
        "message と userReplies を読んでください。",
        "ユーザーが関心・拒否・中立・判定不能のどれに近いかを判断してください。",
        "observation と feedbackNote を返してください。",
      ].join(" "),
      message: log.message,
      userReplies,
      candidateKind: log.candidateKind,
      topicLabel: log.topicLabel ?? "",
    }),
  );
  return {
    kind: "resolved",
    observation: normalizeObservation(parsed.observation),
    feedbackNote:
      parsed.feedbackNote?.trim() || "反応の解釈を簡潔にまとめた。",
  };
};

const inferBeliefUpdates = async (
  plannerModel: DialoguePlanningModel,
  belief: UserBelief,
  log: InteractionLog,
): Promise<BeliefUpdate[]> => {
  const parsed = await plannerModel.generateJson<BeliefUpdateResult>(
    [
      "あなたはユーザー belief の差分更新を提案します。",
      "現在の belief と、直近の InteractionLog の観測結果を読み、必要な update だけを返してください。",
      "無反応の場合は、topic interest を安易に下げず initiation tolerance を慎重に下げてください。",
      "updates は topicLabel, topicSummary, interestDelta, confidenceDelta, initiationToleranceDelta, note を持てます。",
      "JSON のみを返してください。",
    ].join(" "),
    JSON.stringify({
      instruction: [
        "currentBelief と interactionLog を読んでください。",
        "必要な belief update だけを返してください。",
        "updates は空配列でも構いません。",
      ].join(" "),
      currentBelief: belief,
      interactionLog: {
        candidateKind: log.candidateKind,
        topicLabel: log.topicLabel ?? "",
        message: log.message,
        observation: log.observation,
        feedbackNote: log.feedbackNote,
      },
    }),
  );
  return (parsed.updates ?? [])
    .map((item) => normalizeBeliefUpdate(item))
    .filter((item): item is BeliefUpdate => item !== null);
};

const normalizeBeliefUpdate = (value: {
  topicLabel?: string;
  topicSummary?: string;
  interestDelta?: number;
  confidenceDelta?: number;
  initiationToleranceDelta?: number;
  note?: string;
}): BeliefUpdate | null => {
  const topicLabel = value.topicLabel?.trim();
  const note = value.note?.trim();
  if (!topicLabel || !note) {
    return null;
  }
  return {
    topicLabel,
    ...(value.topicSummary?.trim()
      ? { topicSummary: value.topicSummary.trim() }
      : {}),
    interestDelta: clampDelta(value.interestDelta),
    confidenceDelta: clampDelta(value.confidenceDelta),
    initiationToleranceDelta: clampDelta(value.initiationToleranceDelta),
    note,
  };
};

const applyBeliefUpdates = (
  belief: UserBelief,
  updates: BeliefUpdate[],
  evidenceRef: string,
  nowIso: string,
): UserBelief => {
  let next = { ...belief, topics: [...belief.topics], updatedAtIso: nowIso };
  let toleranceScore = toleranceToScore(next.initiationTolerance);
  for (const update of updates) {
    const index = next.topics.findIndex((topic) => topic.label === update.topicLabel);
    const current = index >= 0 ? next.topics[index] : undefined;
    const topic: TopicBelief = {
      id: current?.id ?? `topic_${sanitize(update.topicLabel)}`,
      label: update.topicLabel,
      summary: update.topicSummary ?? current?.summary ?? update.note,
      interest: clampInterest((current?.interest ?? 0) + update.interestDelta),
      confidence: shiftConfidence(current?.confidence ?? "low", update.confidenceDelta),
      lastObservedAtIso: nowIso,
      evidenceRefs: Array.from(
        new Set([...(current?.evidenceRefs ?? []), evidenceRef]),
      ).slice(-10),
      note: update.note,
    };
    if (index >= 0) {
      next.topics[index] = topic;
    } else {
      next.topics.push(topic);
    }
    toleranceScore += update.initiationToleranceDelta;
  }
  next.initiationTolerance = scoreToTolerance(toleranceScore);
  return next;
};

const createDefaultBelief = (userId: string, nowIso: string): UserBelief => ({
  userId,
  topics: [],
  initiationTolerance: "unknown",
  updatedAtIso: nowIso,
});

const buildBackgroundInstruction = (candidate: DialogueCandidate): string =>
  [
    "これはユーザーからの入力ではなく、background からの介入指示です。",
    "次にユーザーへ送る日本語メッセージを 1 通だけ作成してください。",
    `候補種別: ${candidate.kind}`,
    ...(candidate.topicLabel ? [`話題: ${candidate.topicLabel}`] : []),
    `意図: ${candidate.intent}`,
    ...(candidate.reason ? [`理由: ${candidate.reason}`] : []),
    ...(candidate.draftMessage ? [`叩き台: ${candidate.draftMessage}`] : []),
    "制約:",
    "- 内部事情や background system の存在は説明しないでください。",
    "- ユーザーの代わりに答えないでください。",
    "- 自然な 1 文または 2 文に整えてください。",
    "- 最終的なユーザー向けメッセージ本文だけを返してください。",
  ].join("\n");

const selectCandidate = (
  result: CandidatePlanningResult,
): DialogueCandidate | null => {
  const candidates = (result.candidates ?? []).filter(isValidCandidate);
  if (candidates.length === 0) {
    return null;
  }
  const selectedIndex = Math.max(
    0,
    Math.min(candidates.length - 1, result.selectedIndex ?? candidates.length - 1),
  );
  return candidates[selectedIndex] ?? null;
};

const isValidCandidate = (candidate: DialogueCandidate): boolean =>
  Boolean(candidate.kind && candidate.intent?.trim() && candidate.reason?.trim());

const formatRecentTurns = (turns: TurnRecord[]): string[] =>
  turns
    .flatMap((turn) => turn.messages)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `[${message.role}] ${message.content.trim()}`)
    .filter(Boolean)
    .slice(-12);

const normalizeObservation = (
  value: InteractionObservation | string | undefined,
): InteractionObservation => {
  if (
    value === "positive" ||
    value === "negative" ||
    value === "neutral" ||
    value === "no_response" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
};

const clampDelta = (value: number | undefined): -1 | 0 | 1 => {
  if (value === 1) {
    return 1;
  }
  if (value === -1) {
    return -1;
  }
  return 0;
};

const clampInterest = (value: number): -2 | -1 | 0 | 1 | 2 => {
  if (value >= 2) {
    return 2;
  }
  if (value <= -2) {
    return -2;
  }
  if (value >= 1) {
    return 1;
  }
  if (value <= -1) {
    return -1;
  }
  return 0;
};

const shiftConfidence = (
  current: "low" | "medium" | "high",
  delta: -1 | 0 | 1,
): "low" | "medium" | "high" => {
  const order = ["low", "medium", "high"] as const;
  const index = order.indexOf(current);
  return order[Math.max(0, Math.min(order.length - 1, index + delta))] ?? current;
};

const toleranceToScore = (value: InitiationTolerance): number => {
  switch (value) {
    case "low":
      return 0;
    case "medium":
      return 1;
    case "high":
      return 2;
    case "unknown":
    default:
      return 1;
  }
};

const scoreToTolerance = (value: number): InitiationTolerance => {
  if (value <= 0) {
    return "low";
  }
  if (value >= 2) {
    return "high";
  }
  return "medium";
};

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");
