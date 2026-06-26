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
  initialDomainCandidates?: string[];
  backgroundInputSink?: BackgroundInputSink;
  contextProvider?: PomdpContextProvider;
  recentTurnLimit?: number;
  interactionLogLimit?: number;
  observeWindowTurns?: number;
  pendingTimeoutMs?: number;
  dispatchCooldownMs?: number;
  maxPendingInteractions?: number;
  interactionStartHour?: number;
  interactionEndHour?: number;
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
    targetDomain?: string;
    targetTopic?: string;
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
  private readonly pendingTimeoutMs: number;
  private readonly dispatchCooldownMs: number;
  private readonly maxPendingInteractions: number;
  private readonly interactionStartHour: number;
  private readonly interactionEndHour: number;
  private readonly now: () => Date;
  private readonly initialDomainCandidates: string[];

  constructor(private readonly options: SimplePomdpSystemOptions) {
    this.recentTurnLimit = Math.max(1, options.recentTurnLimit ?? 12);
    this.interactionLogLimit = Math.max(1, options.interactionLogLimit ?? 20);
    this.observeWindowTurns = Math.max(1, options.observeWindowTurns ?? 3);
    this.pendingTimeoutMs = Math.max(
      0,
      options.pendingTimeoutMs ?? 6 * 60 * 60 * 1000,
    );
    this.dispatchCooldownMs = Math.max(
      0,
      options.dispatchCooldownMs ?? 60 * 60 * 1000,
    );
    this.maxPendingInteractions = Math.max(
      1,
      options.maxPendingInteractions ?? 1,
    );
    this.interactionStartHour = clampHour(options.interactionStartHour ?? 0);
    this.interactionEndHour = clampHour(options.interactionEndHour ?? 24);
    this.now = options.now ?? (() => new Date());
    this.initialDomainCandidates = (options.initialDomainCandidates ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  async ingestTurnRecord(input: TurnRecord): Promise<void> {
    await this.options.turnRecordStore.appendTurnRecord(input);
    logSimplePomdp(
      `ingested turn botId=${input.botId} threadId=${input.threadId} messages=${input.messages.length} createdAt=${input.createdAtIso}`,
    );
  }

  async listUserBelief(input: { userId: string }): Promise<UserBelief | null> {
    const belief = await this.options.userBeliefStore.getUserBelief(
      input.userId,
    );
    return belief ? normalizeUserBelief(belief) : null;
  }

  async dispatchNext(input: {
    botId: string;
    threadId: string;
    userId: string;
  }): Promise<BackgroundInput[]> {
    logSimplePomdp(
      `dispatch start botId=${input.botId} threadId=${input.threadId} userId=${input.userId}`,
    );
    await this.refreshBeliefFromPendingInteractions(input);

    const belief =
      normalizeStoredBelief(
        await this.options.userBeliefStore.getUserBelief(input.userId),
      ) ?? createDefaultBelief(input.userId, this.now().toISOString());
    const interactionLogs = (
      await this.options.interactionLogStore.listRecentInteractionLogs({
        userId: input.userId,
        limit: this.interactionLogLimit,
      })
    ).map((log) => normalizeInteractionLog(log, this.observeWindowTurns));
    const pendingLogs = interactionLogs.filter(
      (log) =>
        log.botId === input.botId &&
        log.threadId === input.threadId &&
        isPendingInteraction(log),
    );
    logSimplePomdp(
      `dispatch state threadId=${input.threadId} topics=${belief.topics.length} logs=${interactionLogs.length} pending=${pendingLogs.length}`,
    );
    if (pendingLogs.length >= this.maxPendingInteractions) {
      logSimplePomdp(
        `dispatch skip threadId=${input.threadId} reason=max_pending_interactions pending=${pendingLogs.length} limit=${this.maxPendingInteractions}`,
      );
      return [];
    }
    const currentHour = this.now().getHours();
    if (
      !isWithinInteractionHours(
        currentHour,
        this.interactionStartHour,
        this.interactionEndHour,
      )
    ) {
      logSimplePomdp(
        `dispatch skip threadId=${input.threadId} reason=outside_interaction_hours currentHour=${currentHour} startHour=${this.interactionStartHour} endHour=${this.interactionEndHour}`,
      );
      return [];
    }
    const latestInteraction = [...interactionLogs]
      .filter(
        (log) =>
          log.botId === input.botId &&
          log.threadId === input.threadId &&
          log.candidateKind !== "do_nothing",
      )
      .sort(
        (left, right) =>
          Date.parse(right.createdAtIso) - Date.parse(left.createdAtIso),
      )[0];
    if (
      latestInteraction &&
      this.now().getTime() - Date.parse(latestInteraction.createdAtIso) <
        this.dispatchCooldownMs
    ) {
      logSimplePomdp(
        `dispatch skip threadId=${input.threadId} reason=cooldown latest=${latestInteraction.createdAtIso} cooldownMs=${this.dispatchCooldownMs}`,
      );
      return [];
    }

    const recentTurns =
      await this.options.turnRecordStore.listRecentTurnRecords({
        botId: input.botId,
        threadId: input.threadId,
        limit: this.recentTurnLimit,
      });
    const context = this.options.contextProvider
      ? await this.options.contextProvider.getContext(input)
      : {};
    const plannerSignals = buildPlannerSignals(
      recentTurns,
      interactionLogs,
      this.now(),
      input.botId,
      input.threadId,
    );
    logSimplePomdp(
      `planning input threadId=${input.threadId} recentTurns=${recentTurns.length} contextNotes=${context.notes?.length ?? 0} userInactivity=${plannerSignals.hoursSinceLastUserTurnBucket} agentInactivity=${plannerSignals.hoursSinceLastAgentInitiatedBucket} doNothing=${plannerSignals.recentDoNothingCount} noResponse=${plannerSignals.recentNoResponseCount}`,
    );
    const planning = await this.planCandidates({
      belief,
      recentTurns,
      interactionLogs: interactionLogs.slice(-this.interactionLogLimit),
      context,
      plannerSignals,
      initialDomainCandidates: this.initialDomainCandidates,
    });
    logSimplePomdp(
      `planning result threadId=${input.threadId} candidates=${planning.candidates?.length ?? 0} selectedIndex=${planning.selectedIndex ?? -1}`,
    );
    console.log("planning", planning);
    const selected = selectCandidate(planning);
    if (!selected) {
      logSimplePomdp(
        `dispatch skip threadId=${input.threadId} reason=no_valid_candidate`,
      );
      return [];
    }
    if (selected.kind === "do_nothing") {
      await this.options.interactionLogStore.saveInteractionLog({
        id: `pomdp_${sanitize(input.userId)}_${this.now().toISOString()}`,
        userId: input.userId,
        botId: input.botId,
        threadId: input.threadId,
        candidateKind: selected.kind,
        ...(selected.probeType ? { probeType: selected.probeType } : {}),
        ...(selected.targetDomain
          ? { targetDomain: selected.targetDomain }
          : {}),
        ...(selected.targetTopic ? { targetTopic: selected.targetTopic } : {}),
        message: selected.reason.trim(),
        status: "resolved",
        observation: "unknown",
        feedbackNote: selected.reason.trim(),
        observeWindowTurns: this.observeWindowTurns,
        createdAtIso: this.now().toISOString(),
        resolvedAtIso: this.now().toISOString(),
      });
      logSimplePomdp(
        `dispatch skip threadId=${input.threadId} reason=do_nothing recorded=true`,
      );
      return [];
    }
    logSimplePomdp(
      `candidate selected threadId=${input.threadId} kind=${selected.kind}${selected.targetDomain ? ` domain=${selected.targetDomain}` : ""}${selected.targetTopic ? ` topic=${selected.targetTopic}` : ""} benefit=${selected.expectedBenefit} risk=${selected.expectedRisk}`,
    );

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
      ...(selected.probeType ? { probeType: selected.probeType } : {}),
      ...(selected.targetDomain ? { targetDomain: selected.targetDomain } : {}),
      ...(selected.targetTopic ? { targetTopic: selected.targetTopic } : {}),
      message: selected.draftMessage?.trim() || selected.intent.trim(),
      status: "pending",
      observation: "unknown",
      feedbackNote: "",
      observeWindowTurns: this.observeWindowTurns,
      createdAtIso: this.now().toISOString(),
    });
    logSimplePomdp(
      `dispatched botId=${input.botId} threadId=${input.threadId} interactionId=${interactionId} candidate=${selected.kind}${selected.targetDomain ? ` domain=${selected.targetDomain}` : ""}${selected.targetTopic ? ` topic=${selected.targetTopic}` : ""}`,
    );
    return [backgroundInput];
  }

  private async refreshBeliefFromPendingInteractions(input: {
    botId: string;
    threadId: string;
    userId: string;
  }): Promise<void> {
    const logs =
      await this.options.interactionLogStore.listRecentInteractionLogs({
        userId: input.userId,
        limit: this.interactionLogLimit,
      });
    const pending = logs.filter(
      (log) =>
        log.botId === input.botId &&
        log.threadId === input.threadId &&
        isPendingInteraction(log),
    );
    if (pending.length === 0) {
      return;
    }
    logSimplePomdp(
      `refresh start threadId=${input.threadId} pendingInteractions=${pending.length}`,
    );
    const belief =
      normalizeStoredBelief(
        await this.options.userBeliefStore.getUserBelief(input.userId),
      ) ?? createDefaultBelief(input.userId, this.now().toISOString());
    const turns = await this.options.turnRecordStore.listRecentTurnRecords({
      botId: input.botId,
      threadId: input.threadId,
      limit: this.recentTurnLimit + this.observeWindowTurns + 2,
    });

    for (const log of pending) {
      logSimplePomdp(
        `observe start threadId=${input.threadId} interactionId=${log.id} kind=${log.candidateKind}${log.targetDomain ? ` domain=${log.targetDomain}` : ""}${log.targetTopic ? ` topic=${log.targetTopic}` : ""}`,
      );
      const observation = await observeInteraction(
        this.options.plannerModel,
        log,
        turns,
        this.now(),
        this.pendingTimeoutMs,
      );
      if (observation.kind === "pending") {
        logSimplePomdp(
          `observe pending threadId=${input.threadId} interactionId=${log.id} windowTurns=${this.observeWindowTurns}`,
        );
        continue;
      }
      const completedLog: InteractionLog = {
        ...log,
        status: observation.status,
        observation: observation.observation,
        feedbackNote: observation.feedbackNote,
        resolvedAtIso: this.now().toISOString(),
      };
      await this.options.interactionLogStore.saveInteractionLog(completedLog);
      logSimplePomdp(
        `observe resolved threadId=${input.threadId} interactionId=${log.id} observation=${observation.observation}`,
      );
      const updates = await inferBeliefUpdates(
        this.options.plannerModel,
        belief,
        completedLog,
      );
      logSimplePomdp(
        `belief updates threadId=${input.threadId} interactionId=${log.id} updates=${updates.length}`,
      );
      const nextBelief = applyBeliefUpdates(
        belief,
        updates,
        completedLog,
        this.now().toISOString(),
      );
      await this.options.userBeliefStore.saveUserBelief(nextBelief);
      logSimplePomdp(
        `belief saved threadId=${input.threadId} interactionId=${log.id} topics=${nextBelief.topics.length} initiationTolerance=${nextBelief.initiationTolerance}`,
      );
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
    plannerSignals: PlannerSignals;
    initialDomainCandidates: string[];
  }): Promise<CandidatePlanningResult> {
    return this.options.plannerModel.generateJson<CandidatePlanningResult>(
      [
        "あなたは POMDP ベースの proactive dialogue planner です。",
        "belief をもとに、agent からユーザーへ話しかける候補を 3 から 5 個作ってください。",
        "候補には exploit, refine, explore, do_nothing を使えます。",
        "do_nothing は必ず 1 つ含めてください。",
        "各 candidate には kind, probeType, targetDomain, optional targetTopic, intent, draftMessage, expectedBenefit, expectedRisk, reason を入れてください。",
        "explore は breadth に寄せてください。broad domain 候補からかなりランダムに選び、最近の会話と直接関係ない領域も候補に含めてください。",
        "refine は既に反応のあった domain/topic を少し絞る候補です。",
        "exploit は十分に方向性が見えている domain/topic に価値提供する候補です。",
        "positiveCount がある topic は refine や exploit に寄せてください。",
        "negativeCount がある topic は避けてください。",
        //"no_response はマイナスではありません。明示的な negative だけを強いマイナスとして扱ってください。",
        "no_responseが多い場合、do_nothingを選択してはいけません。積極的に探索を行ってください。",
        "exploit が中心でも breadth explore を少し残してください。",
        "その後、期待される便益がリスクを上回る候補を 1 つ選び、selectedIndex で返してください。",
        "JSON のみを返してください。",
      ].join(" "),
      JSON.stringify({
        instruction: [
          "userBelief, recentTurns, recentInteractionLogs, optionalContext を読んでください。",
          "plannerSignals には、最後のユーザー入力や最後の agent 介入からの経過時間バケット、直近の do_nothing 回数、直近の no_response 回数が入っています。",
          "initialDomainCandidates は、初対面で広く探るための幅広い領域候補です。",
          "attemptCount が少ない topic や未登場の domain は breadth explore の優先候補です。",
          "breadth explore では initialDomainCandidates から偏らず広く、かなりランダムに選んでください。",
          "positiveCount が高い topic は refine/exploit を優先できます。",
          "negativeCount がある topic は避けてください。",
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
          probeType: log.probeType,
          targetDomain: log.targetDomain,
          targetTopic: log.targetTopic,
          message: log.message,
          observation: log.observation,
          feedbackNote: log.feedbackNote,
          createdAtIso: log.createdAtIso,
        })),
        optionalContext: {
          recentContextSummary: input.context.recentContextSummary ?? "",
          notes: input.context.notes ?? [],
        },
        plannerSignals: input.plannerSignals,
        initialDomainCandidates: input.initialDomainCandidates,
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
  now: Date,
  pendingTimeoutMs: number,
): Promise<
  | { kind: "pending" }
  | {
      kind: "resolved";
      status: "resolved" | "expired";
      observation: InteractionObservation;
      feedbackNote: string;
    }
> => {
  const interactionAt = Date.parse(log.createdAtIso);
  if (
    pendingTimeoutMs > 0 &&
    now.getTime() - interactionAt >= pendingTimeoutMs
  ) {
    console.log("[observeInteraction] timeout");
    return {
      kind: "resolved",
      status: "expired",
      observation: "no_response",
      feedbackNote: "観測タイムアウト内にユーザーから明示的な反応はなかった。",
    };
  }

  const subsequentTurns = turns.filter(
    (turn) => Date.parse(turn.createdAtIso) > interactionAt,
  );

  const observedTurns = subsequentTurns.slice(0, log.observeWindowTurns);
  const observedMessages = observedTurns
    .flatMap((turn) => turn.messages)
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => `[${message.role}] ${message.content.trim()}`)
    .filter(Boolean);
  const hasUserMessage = observedTurns.some((turn) =>
    turn.messages.some(
      (message) => message.role === "user" && message.content.trim().length > 0,
    ),
  );

  if (!hasUserMessage && subsequentTurns.length < log.observeWindowTurns) {
    console.log("[observeInteraction] set pending");
    return { kind: "pending" };
  }
  if (!hasUserMessage) {
    console.log("[observeInteraction] no user message");
    return {
      kind: "resolved",
      status: "expired",
      observation: "no_response",
      feedbackNote: "観測窓内にユーザーから明示的な反応はなかった。",
    };
  }
  console.log("[observeInteraction] log", log);
  console.log("[observeInteraction] observedMessages", observedMessages);
  const parsed = await plannerModel.generateJson<ObservationResult>(
    [
      "あなたは、agent からの自発的な話しかけに対するユーザー反応を分類します。",
      "message は agent がユーザーへ伝えた内容です。",
      "observedWindow はその後 N ターンの会話履歴です。",
      "個別の user reply を特定するのではなく、この窓全体に反応が含まれるかを見てください。",
      "observation は positive, negative, neutral, no_response, unknown のいずれかです。",
      "feedbackNote には短い自然言語の説明を返してください。",
      "JSON のみを返してください。",
    ].join(" "),
    JSON.stringify({
      instruction: [
        "message と observedWindow を読んでください。",
        "この働きかけに対して、観測窓の中でユーザーが前向き・拒否・中立・判定不能のどれに近いかを判断してください。",
        "observation と feedbackNote を返してください。",
      ].join(" "),
      message: log.message,
      observeWindowTurns: log.observeWindowTurns,
      observedWindow: observedMessages,
      candidateKind: log.candidateKind,
      probeType: log.probeType ?? "breadth",
      targetDomain: log.targetDomain ?? "",
      targetTopic: log.targetTopic ?? "",
    }),
  );
  return {
    kind: "resolved",
    status: "resolved",
    observation: normalizeObservation(parsed.observation),
    feedbackNote: parsed.feedbackNote?.trim() || "反応の解釈を簡潔にまとめた。",
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
      "無反応の場合は、topic interest を下げないでください。明示的な negative だけを topic の強いマイナスとして扱ってください。",
      "updates は targetDomain, optional targetTopic, interestDelta, confidenceDelta, initiationToleranceDelta, note を持てます。",
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
        probeType: log.probeType ?? "breadth",
        targetDomain: log.targetDomain ?? "",
        targetTopic: log.targetTopic ?? "",
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
  targetDomain?: string;
  targetTopic?: string;
  interestDelta?: number;
  confidenceDelta?: number;
  initiationToleranceDelta?: number;
  note?: string;
}): BeliefUpdate | null => {
  const targetDomain = value.targetDomain?.trim();
  const targetTopic = value.targetTopic?.trim();
  const note = value.note?.trim();
  if (!targetDomain || !note) {
    return null;
  }
  return {
    targetDomain,
    ...(targetTopic ? { targetTopic } : {}),
    interestDelta: clampDelta(value.interestDelta),
    confidenceDelta: clampDelta(value.confidenceDelta),
    initiationToleranceDelta: clampDelta(value.initiationToleranceDelta),
    note,
  };
};

const applyBeliefUpdates = (
  belief: UserBelief,
  updates: BeliefUpdate[],
  interactionLog: InteractionLog,
  nowIso: string,
): UserBelief => {
  let next = { ...belief, topics: [...belief.topics], updatedAtIso: nowIso };
  let toleranceScore = toleranceToScore(next.initiationTolerance);
  for (const update of updates) {
    const index = next.topics.findIndex(
      (topic) =>
        topic.domain === update.targetDomain &&
        (topic.topic ?? "") === (update.targetTopic ?? ""),
    );
    const current = index >= 0 ? next.topics[index] : undefined;
    const topic: TopicBelief = {
      id:
        current?.id ??
        `topic_${sanitize(update.targetDomain)}_${sanitize(update.targetTopic ?? "general")}`,
      domain: update.targetDomain,
      ...(update.targetTopic ? { topic: update.targetTopic } : {}),
      interest: clampInterest((current?.interest ?? 0) + update.interestDelta),
      confidence: shiftConfidence(
        current?.confidence ?? "low",
        update.confidenceDelta,
      ),
      attemptCount: current?.attemptCount ?? 0,
      positiveCount: current?.positiveCount ?? 0,
      negativeCount: current?.negativeCount ?? 0,
      lastObservedAtIso: nowIso,
      note: update.note,
    };
    if (index >= 0) {
      next.topics[index] = topic;
    } else {
      next.topics.push(topic);
    }
    toleranceScore += update.initiationToleranceDelta;
  }
  next = applyObservationCounts(next, updates, interactionLog, nowIso);
  next.initiationTolerance = scoreToTolerance(toleranceScore);
  return next;
};

const applyObservationCounts = (
  belief: UserBelief,
  updates: BeliefUpdate[],
  interactionLog: InteractionLog,
  nowIso: string,
): UserBelief => {
  const next = { ...belief, topics: [...belief.topics] };
  const targetKeys = new Set([
    ...updates.map((update) =>
      toTopicKey(update.targetDomain, update.targetTopic),
    ),
    ...(interactionLog.targetDomain
      ? [toTopicKey(interactionLog.targetDomain, interactionLog.targetTopic)]
      : []),
  ]);
  for (const key of targetKeys) {
    const target = parseTopicKey(key);
    const index = next.topics.findIndex(
      (topic) =>
        topic.domain === target.domain &&
        (topic.topic ?? "") === (target.topic ?? ""),
    );
    const current =
      index >= 0
        ? next.topics[index]
        : createObservedTopicBelief(
            target.domain,
            target.topic,
            nowIso,
            interactionLog.feedbackNote,
          );
    const updated = incrementTopicObservationCount(
      current,
      interactionLog.observation,
      nowIso,
    );
    if (index >= 0) {
      next.topics[index] = updated;
    } else {
      next.topics.push(updated);
    }
  }
  return incrementUserObservationCount(next, interactionLog.observation);
};

const logSimplePomdp = (message: string): void => {
  process.stdout.write(`[simple-pomdp] ${message}\n`);
};

const createDefaultBelief = (userId: string, nowIso: string): UserBelief => ({
  userId,
  topics: [],
  initiationTolerance: "unknown",
  initiationPositiveCount: 0,
  initiationNegativeCount: 0,
  initiationNoResponseCount: 0,
  updatedAtIso: nowIso,
});

const createObservedTopicBelief = (
  domain: string,
  topic: string | undefined,
  nowIso: string,
  note: string,
): TopicBelief => ({
  id: `topic_${sanitize(domain)}_${sanitize(topic ?? "general")}`,
  domain,
  ...(topic ? { topic } : {}),
  interest: 0,
  confidence: "low",
  attemptCount: 0,
  positiveCount: 0,
  negativeCount: 0,
  lastObservedAtIso: nowIso,
  note: note || topic || domain,
});

const normalizeStoredBelief = (belief: UserBelief | null): UserBelief | null =>
  belief ? normalizeUserBelief(belief) : null;

const normalizeUserBelief = (belief: UserBelief): UserBelief => ({
  ...belief,
  topics: belief.topics.map((topic) => ({
    ...topic,
    topic: topic.topic?.trim() || undefined,
    attemptCount: topic.attemptCount ?? 0,
    positiveCount: topic.positiveCount ?? 0,
    negativeCount: topic.negativeCount ?? 0,
  })),
  initiationPositiveCount: belief.initiationPositiveCount ?? 0,
  initiationNegativeCount: belief.initiationNegativeCount ?? 0,
  initiationNoResponseCount: belief.initiationNoResponseCount ?? 0,
});

const normalizeInteractionLog = (
  log: InteractionLog,
  defaultObserveWindowTurns: number,
): InteractionLog => ({
  ...log,
  status:
    log.status ?? (log.observation === "unknown" ? "pending" : "resolved"),
  observeWindowTurns: log.observeWindowTurns ?? defaultObserveWindowTurns,
});

interface PlannerSignals {
  hoursSinceLastUserTurnBucket: string;
  hoursSinceLastAgentInitiatedBucket: string;
  recentDoNothingCount: number;
  recentNoResponseCount: number;
}

const buildPlannerSignals = (
  turns: TurnRecord[],
  interactionLogs: InteractionLog[],
  now: Date,
  botId: string,
  threadId: string,
): PlannerSignals => {
  const threadTurns = turns.filter(
    (turn) => turn.botId === botId && turn.threadId === threadId,
  );
  const lastUserTimestampIso = [...threadTurns]
    .flatMap((turn) => turn.messages)
    .filter((message) => message.role === "user")
    .map((message) => message.timestampIso)
    .sort()
    .at(-1);
  const lastAgentInteractionIso = interactionLogs
    .filter(
      (log) =>
        log.botId === botId &&
        log.threadId === threadId &&
        log.candidateKind !== "do_nothing",
    )
    .map((log) => log.createdAtIso)
    .sort()
    .at(-1);
  const threadLogs = interactionLogs.filter(
    (log) => log.botId === botId && log.threadId === threadId,
  );
  return {
    hoursSinceLastUserTurnBucket: toHourBucket(lastUserTimestampIso, now),
    hoursSinceLastAgentInitiatedBucket: toHourBucket(
      lastAgentInteractionIso,
      now,
    ),
    recentDoNothingCount: threadLogs.filter(
      (log) => log.candidateKind === "do_nothing",
    ).length,
    recentNoResponseCount: threadLogs.filter(
      (log) => log.observation === "no_response",
    ).length,
  };
};

const toHourBucket = (iso: string | undefined, now: Date): string => {
  if (!iso) {
    return "never";
  }
  const hours = Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(iso)) / (60 * 60 * 1000)),
  );
  if (hours >= 24) {
    return "24h+";
  }
  return `${hours}h`;
};

const buildBackgroundInstruction = (candidate: DialogueCandidate): string =>
  [
    "これはユーザーからの入力ではなく、background からの介入指示です。",
    "次にユーザーへ送る日本語メッセージを 1 通だけ作成してください。",
    `候補種別: ${candidate.kind}`,
    ...(candidate.probeType ? [`探索種別: ${candidate.probeType}`] : []),
    ...(candidate.targetDomain ? [`領域: ${candidate.targetDomain}`] : []),
    ...(candidate.targetTopic ? [`話題: ${candidate.targetTopic}`] : []),
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
    Math.min(
      candidates.length - 1,
      result.selectedIndex ?? candidates.length - 1,
    ),
  );
  return candidates[selectedIndex] ?? null;
};

const isValidCandidate = (candidate: DialogueCandidate): boolean =>
  Boolean(
    candidate.kind &&
      candidate.intent?.trim() &&
      candidate.reason?.trim() &&
      candidate.expectedBenefit &&
      candidate.expectedRisk,
  );

const formatRecentTurns = (turns: TurnRecord[]): string[] =>
  turns
    .flatMap((turn) => turn.messages)
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
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

const isPendingInteraction = (log: InteractionLog): boolean =>
  log.status === "pending" ||
  ((log.status === undefined || log.status === null) &&
    log.observation === "unknown");

const clampDelta = (value: number | undefined): -1 | 0 | 1 => {
  if (value === 1) {
    return 1;
  }
  if (value === -1) {
    return -1;
  }
  return 0;
};

const clampHour = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(24, Math.floor(value)));
};

const isWithinInteractionHours = (
  currentHour: number,
  startHour: number,
  endHour: number,
): boolean => {
  if (startHour === endHour) {
    return true;
  }
  if (startHour < endHour) {
    return currentHour >= startHour && currentHour < endHour;
  }
  return currentHour >= startHour || currentHour < endHour;
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
  return (
    order[Math.max(0, Math.min(order.length - 1, index + delta))] ?? current
  );
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

const incrementTopicObservationCount = (
  topic: TopicBelief,
  observation: InteractionObservation,
  nowIso: string,
): TopicBelief => ({
  ...topic,
  attemptCount: topic.attemptCount + 1,
  positiveCount: topic.positiveCount + (observation === "positive" ? 1 : 0),
  negativeCount: topic.negativeCount + (observation === "negative" ? 1 : 0),
  lastObservedAtIso: nowIso,
});

const toTopicKey = (domain: string, topic?: string): string =>
  `${domain}::${topic ?? ""}`;

const parseTopicKey = (value: string): { domain: string; topic?: string } => {
  const [domain, topic] = value.split("::", 2);
  return {
    domain,
    ...(topic ? { topic } : {}),
  };
};

const incrementUserObservationCount = (
  belief: UserBelief,
  observation: InteractionObservation,
): UserBelief => ({
  ...belief,
  initiationPositiveCount:
    belief.initiationPositiveCount + (observation === "positive" ? 1 : 0),
  initiationNegativeCount:
    belief.initiationNegativeCount + (observation === "negative" ? 1 : 0),
  initiationNoResponseCount:
    belief.initiationNoResponseCount + (observation === "no_response" ? 1 : 0),
});

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
