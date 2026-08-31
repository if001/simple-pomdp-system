import { describe } from "node:test";
import {
  BackgroundInput,
  BackgroundInputSink,
  DialogueDecision,
  DialoguePlanningModel,
  InteractionLog,
  InteractionLogStore,
  InteractionObservation,
  PomdpContextProvider,
  TurnRecord,
  TurnRecordReader,
  UserBelief,
  UserBeliefStore,
  TopicBelief,
  ExploitResearchAgent,
  ExploitResearchResult,
} from "../domain/types";

export interface SimplePomdpSystemService {
  listUserBelief(input: { userId: string }): Promise<UserBelief | null>;
  dispatchNext(input: {
    botId: string;
    threadId: string;
    userId: string;
  }): Promise<BackgroundInput[]>;
}

export interface SimplePomdpSystemOptions {
  turnRecordReader: TurnRecordReader;
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
  exploitResearchAgent?: ExploitResearchAgent;
  now?: () => Date;
}

interface ObservationResult {
  observation?: InteractionObservation;
  feedbackNote?: string;
}

interface RawDialogueDecision {
  kind?: string;
  targetDomain?: string;
  targetTopic?: string;
  messageIntent?: string;
  reason?: string;
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

    let belief =
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
      await this.options.turnRecordReader.listRecentTurnRecords({
        botId: input.botId,
        threadId: input.threadId,
        limit: this.recentTurnLimit,
      });
    const context = this.options.contextProvider
      ? await this.options.contextProvider.getContext(input)
      : {};
    const planningNow = this.now();
    const plannerSignals = buildPlannerSignals(
      recentTurns,
      interactionLogs,
      planningNow,
      input.botId,
      input.threadId,
    );
    logSimplePomdp(
      `planning input threadId=${input.threadId} recentTurns=${recentTurns.length} contextNotes=${context.notes?.length ?? 0} userInactivity=${plannerSignals.hoursSinceLastUserTurnBucket} agentInactivity=${plannerSignals.hoursSinceLastAgentInitiatedBucket}`,
    );
    const decision = await this.decideNextInteraction({
      belief,
      recentTurns,
      interactionLogs: interactionLogs.slice(-this.interactionLogLimit),
      context,
      plannerSignals,
      initialDomainCandidates: this.initialDomainCandidates,
      now: planningNow,
    });
    logSimplePomdp(
      `planning result threadId=${input.threadId} kind=${decision?.kind ?? "invalid"}`,
    );
    if (decision?.kind == "do_nothing") {
      logSimplePomdp(
        "decision\n" +
          `kind:${decision.kind}\n` +
          `reason: ${decision?.reason}\n`,
      );
    } else {
      logSimplePomdp(
        `decision\n` +
          `kind:${decision.kind}\n` +
          `reason: ${decision?.reason}\n` +
          `targetDomain:${decision?.targetDomain}\n` +
          `targetTopic:${decision?.targetTopic}`,
      );
    }

    if (!decision) {
      logSimplePomdp(
        `dispatch skip threadId=${input.threadId} reason=no_valid_decision`,
      );
      return [];
    }
    if (decision.kind === "do_nothing") {
      await this.options.interactionLogStore.saveInteractionLog({
        id: `pomdp_${sanitize(input.userId)}_${this.now().toISOString()}`,
        userId: input.userId,
        botId: input.botId,
        threadId: input.threadId,
        candidateKind: decision.kind,
        message: decision.reason.trim(),
        status: "resolved",
        observation: "unknown",
        feedbackNote: decision.reason.trim(),
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
      `decision selected threadId=${input.threadId} kind=${decision.kind} domain=${decision.targetDomain}${decision.targetTopic ? ` topic=${decision.targetTopic}` : ""}`,
    );

    const exploitResearch =
      decision.kind === "exploit" && this.options.exploitResearchAgent
        ? await this.options.exploitResearchAgent.research({
            botId: input.botId,
            threadId: input.threadId,
            userId: input.userId,
            targetDomain: decision.targetDomain,
            ...(decision.targetTopic
              ? { targetTopic: decision.targetTopic }
              : {}),
            recentTurns: formatRecentTurns(recentTurns),
            belief,
          })
        : null;

    const interactionId = `pomdp_${sanitize(input.userId)}_${this.now().toISOString()}`;
    const backgroundInput: BackgroundInput = {
      botId: input.botId,
      threadId: input.threadId,
      text: buildBackgroundInstruction(decision, exploitResearch),
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
      candidateKind: decision.kind,
      targetDomain: decision.targetDomain,
      ...(decision.targetTopic ? { targetTopic: decision.targetTopic } : {}),
      message: decision.messageIntent.trim(),
      status: "pending",
      observation: "unknown",
      feedbackNote: "",
      ...(exploitResearch
        ? {
            supportSummary: exploitResearch.summary,
            articleIds: exploitResearch.articleIds,
            sourceUrls: exploitResearch.sourceUrls,
          }
        : {}),
      observeWindowTurns: this.observeWindowTurns,
      createdAtIso: this.now().toISOString(),
    });
    logSimplePomdp(
      `dispatched botId=${input.botId} threadId=${input.threadId} interactionId=${interactionId} decision=${decision.kind} domain=${decision.targetDomain}${decision.targetTopic ? ` topic=${decision.targetTopic}` : ""}`,
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
    let belief =
      normalizeStoredBelief(
        await this.options.userBeliefStore.getUserBelief(input.userId),
      ) ?? createDefaultBelief(input.userId, this.now().toISOString());
    const turns = await this.options.turnRecordReader.listRecentTurnRecords({
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
      const nextBelief = applyInteractionObservationToBelief(
        belief,
        completedLog,
        this.now().toISOString(),
      );
      await this.options.userBeliefStore.saveUserBelief(nextBelief);
      logSimplePomdp(
        `belief saved threadId=${input.threadId} interactionId=${log.id} topics=${nextBelief.topics.length} initiationTolerance=${nextBelief.initiationTolerance}`,
      );
      belief = nextBelief;
    }
  }

  private async decideNextInteraction(input: {
    belief: UserBelief;
    recentTurns: TurnRecord[];
    interactionLogs: InteractionLog[];
    context: {
      recentContextSummary?: string;
      notes?: string[];
    };
    plannerSignals: PlannerSignals;
    initialDomainCandidates: string[];
    now: Date;
  }): Promise<DialogueDecision | null> {
    const raw_prompt = JSON.stringify({
      instruction: [
        "currentSituation, userBeliefSummary, recentTurns, recentInteractions, optionalContext を読んでください。",
        "現在の時刻・曜日は、話題を出す自然さと過去のおすすめをフォローする時期の判断にだけ使ってください。",
        "recentInteractions の経過時間・曜日・時間帯・話題・反応を比較し、無反応の理由は仮説として扱ってください。",
        "initialDomainCandidates は、初対面で広く探るための幅広い領域候補です。",
        "attemptCount は試行済みかの判断にだけ使い、関心の強さとはみなさないでください。",
        "positiveCount が高い topic は refine/exploit を優先できます。",
        "negativeCount がある topic は避けてください。",
        "最終的な DialogueDecision を 1 件だけ返してください。",
      ].join(" "),
      currentSituation: buildCurrentSituation(input.now),
      userBeliefSummary: summarizeBeliefForPlanner(input.belief),
      recentTurns: formatRecentTurns(input.recentTurns),
      recentInteractions: summarizeInteractionsForPlanner(
        input.interactionLogs,
        input.now,
      ),
      optionalContext: {
        recentContextSummary: input.context.recentContextSummary
          ? compactText(input.context.recentContextSummary, 1200)
          : "",
        notes: (input.context.notes ?? [])
          .slice(-6)
          .map((note) => compactText(note, 240)),
      },
      plannerSignals: input.plannerSignals,
      initialDomainCandidates: input.initialDomainCandidates.slice(0, 24),
    });
    console.log("[decideNextInteraction] raw_prompt: ", raw_prompt);
    const parsed =
      await this.options.plannerModel.generateJson<RawDialogueDecision>(
        [
          "あなたは POMDP ベースの proactive dialogue planner です。",
          "今この時点で行う判断を 1 件だけ返してください。kind は exploit, refine, explore のいずれかです。",
          // "話しかける価値が割り込みコストを明確に上回らなければ do_nothing を選んでください。",
          "explore は broad domain 候補から、最近の会話に偏りすぎず未知の関心を低コストに確認します。",
          "refine は既に反応のあった domain/topic を少し絞る候補です。",
          "exploit は十分に方向性が見えている domain/topic に価値提供する候補です。",
          "positiveCount がある topic は refine や exploit に寄せてください。",
          "negativeCount がある topic は避けてください。",
          "no_response は関心がないことを意味しません。単独の no_response で関心や通知許容度を下げないでください。",
          "無反応がある場合は、特定話題だけか、同じ話題の反復か、時間帯に偏るか、メッセージが重いか、材料不足かを最近の履歴から比較してください。理由を断定せず、次の判断では一度に話題・時刻・提示方法の 1 要素だけを変えてください。",
          "異なる話題でも同じ時間帯に無反応なら待つことを、同じ話題だけが続いて無反応なら別領域の短い explore を優先してください。以前 positive だった話題の一度の無反応は関心低下とみなさないでください。",
          "以前おすすめした場所・物・行動を尋ねる場合は、recentInteractions と recentTurns から実際におすすめした事実を確認し、経過時間と現在の曜日・時間帯が自然な場合だけ、訪れた・試したと決めつけず短く尋ねてください。",
          "do_nothing は kind と reason、その他は kind, targetDomain, optional targetTopic, messageIntent, reason を返してください。reason には現在の状況と履歴に基づく短い判断根拠を書いてください。",
          "JSON のみを返してください。",
        ].join(" "),
        raw_prompt,
      );
    return normalizeDialogueDecision(parsed);
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
      "no_responseはネガティブなものではありません。negativeのみがネガティブとします。",
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

const applyInteractionObservationToBelief = (
  belief: UserBelief,
  interactionLog: InteractionLog,
  nowIso: string,
): UserBelief => {
  let next = {
    ...belief,
    topics: [...belief.topics],
    updatedAtIso: nowIso,
  };

  if (interactionLog.targetDomain) {
    next = upsertObservedBelief(
      next,
      interactionLog.targetDomain,
      undefined,
      interactionLog.observation,
      nowIso,
    );
  }

  if (shouldTrackTopicBelief(interactionLog)) {
    next = upsertObservedBelief(
      next,
      interactionLog.targetDomain as string,
      interactionLog.targetTopic,
      interactionLog.observation,
      nowIso,
    );
  }

  next = incrementUserObservationCount(next, interactionLog.observation);
  next = pruneBelief(next);
  return next;
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
  return {
    hoursSinceLastUserTurnBucket: toHourBucket(lastUserTimestampIso, now),
    hoursSinceLastAgentInitiatedBucket: toHourBucket(
      lastAgentInteractionIso,
      now,
    ),
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

const dayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const buildCurrentSituation = (now: Date) => ({
  localDate: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
  dayOfWeek: dayNames[now.getDay()],
  localTime: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
  timeBucket: toTimeBucket(now),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});

const summarizeInteractionsForPlanner = (logs: InteractionLog[], now: Date) =>
  [...logs]
    .sort(
      (left, right) =>
        Date.parse(right.createdAtIso) - Date.parse(left.createdAtIso),
    )
    .slice(0, 8)
    .map((log) => {
      const sentAt = new Date(log.createdAtIso);
      return {
        kind: log.candidateKind,
        ...(log.targetDomain ? { domain: log.targetDomain } : {}),
        ...(log.targetTopic ? { topic: log.targetTopic } : {}),
        message: compactText(log.message, 240),
        observation: log.observation,
        ...(log.feedbackNote
          ? { feedback: compactText(log.feedbackNote, 160) }
          : {}),
        elapsed: toHourBucket(log.createdAtIso, now),
        sentDate: `${sentAt.getFullYear()}-${pad2(sentAt.getMonth() + 1)}-${pad2(sentAt.getDate())}`,
        sentDayOfWeek: dayNames[sentAt.getDay()],
        sentTimeBucket: toTimeBucket(sentAt),
      };
    });

const toTimeBucket = (
  date: Date,
): "morning" | "daytime" | "evening" | "night" => {
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) {
    return "morning";
  }
  if (hour >= 11 && hour < 17) {
    return "daytime";
  }
  if (hour >= 17 && hour < 22) {
    return "evening";
  }
  return "night";
};

const pad2 = (value: number): string => value.toString().padStart(2, "0");

const compactText = (value: string, maxLength: number): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
};

const summarizeBeliefForPlanner = (belief: UserBelief) => ({
  initiationTolerance: belief.initiationTolerance,
  initiationPositiveCount: belief.initiationPositiveCount,
  initiationNegativeCount: belief.initiationNegativeCount,
  initiationNoResponseCount: belief.initiationNoResponseCount,
  trackedDomainCount: belief.topics.filter((topic) => !topic.topic).length,
  trackedTopicCount: belief.topics.filter((topic) => topic.topic).length,
  domains: belief.topics
    .filter((topic) => !topic.topic)
    .sort(compareBeliefImportance)
    .slice(0, 8)
    .map((topic) => ({
      domain: topic.domain,
      interest: topic.interest,
      confidence: topic.confidence,
      attemptCount: topic.attemptCount,
      positiveCount: topic.positiveCount,
      negativeCount: topic.negativeCount,
      lastObservedAtIso: topic.lastObservedAtIso,
    })),
  topics: belief.topics
    .filter((topic) => topic.topic)
    .sort(compareBeliefImportance)
    .slice(0, 12)
    .map((topic) => ({
      domain: topic.domain,
      topic: topic.topic,
      interest: topic.interest,
      confidence: topic.confidence,
      attemptCount: topic.attemptCount,
      positiveCount: topic.positiveCount,
      negativeCount: topic.negativeCount,
      lastObservedAtIso: topic.lastObservedAtIso,
    })),
});

const buildBackgroundInstruction = (
  decision: Exclude<DialogueDecision, { kind: "do_nothing" }>,
  exploitResearch: ExploitResearchResult | null,
): string =>
  [
    "これはユーザーからの入力ではなく、background からの介入指示です。",
    "次にユーザーへ送る日本語メッセージを 1 通だけ作成してください。",
    `判断種別: ${decision.kind}`,
    `領域: ${decision.targetDomain}`,
    ...(decision.targetTopic ? [`話題: ${decision.targetTopic}`] : []),
    `意図: ${decision.messageIntent}`,
    `理由: ${decision.reason}`,
    ...(exploitResearch?.summary
      ? [`調査結果: ${exploitResearch.summary}`]
      : []),
    ...(exploitResearch?.articleIds.length
      ? [`articleIds: ${exploitResearch.articleIds.join(", ")}`]
      : []),
    ...(exploitResearch?.sourceUrls.length
      ? [`sourceUrls: ${exploitResearch.sourceUrls.join(", ")}`]
      : []),
    ...(exploitResearch?.notes.length
      ? [`notes: ${exploitResearch.notes.join(" / ")}`]
      : []),
    "制約:",
    "- 内部事情や background system の存在は説明しないでください。",
    "- ユーザーの代わりに答えないでください。",
    "- 自然な 1 文または 2 文に整えてください。",
    "- 最終的なユーザー向けメッセージ本文だけを返してください。",
  ].join("\n");

const normalizeDialogueDecision = (
  value: RawDialogueDecision | null | undefined,
): DialogueDecision | null => {
  if (!value) {
    return null;
  }
  const reason = value.reason?.trim();
  if (!reason) {
    return null;
  }
  if (value.kind === "do_nothing") {
    return { kind: "do_nothing", reason };
  }
  if (
    (value.kind === "exploit" ||
      value.kind === "refine" ||
      value.kind === "explore") &&
    value.targetDomain?.trim() &&
    value.messageIntent?.trim()
  ) {
    return {
      kind: value.kind,
      targetDomain: value.targetDomain.trim(),
      ...(value.targetTopic?.trim()
        ? { targetTopic: value.targetTopic.trim() }
        : {}),
      messageIntent: value.messageIntent.trim(),
      reason,
    };
  }
  return null;
};

const formatRecentTurns = (turns: TurnRecord[]): string[] =>
  turns
    .flatMap((turn) => turn.messages)
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => {
      const timestamp = new Date(message.timestampIso);
      const localDate = `${timestamp.getFullYear()}-${pad2(timestamp.getMonth() + 1)}-${pad2(timestamp.getDate())}`;
      return `[${localDate} ${dayNames[timestamp.getDay()]} ${toTimeBucket(timestamp)} ${message.role}] ${compactText(message.content, 320)}`;
    })
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

const shouldTrackTopicBelief = (interactionLog: InteractionLog): boolean =>
  Boolean(
    interactionLog.targetDomain &&
      interactionLog.targetTopic &&
      interactionLog.observation !== "unknown" &&
      interactionLog.observation !== "no_response",
  );

const upsertObservedBelief = (
  belief: UserBelief,
  domain: string,
  topic: string | undefined,
  observation: InteractionObservation,
  nowIso: string,
): UserBelief => {
  const index = belief.topics.findIndex(
    (item) => item.domain === domain && (item.topic ?? "") === (topic ?? ""),
  );
  const current =
    index >= 0
      ? belief.topics[index]
      : createObservedTopicBelief(domain, topic, nowIso);
  const updated = applyObservationToTopicBelief(
    incrementTopicObservationCount(current, observation, nowIso),
    observation,
  );
  const topics = [...belief.topics];
  if (index >= 0) {
    topics[index] = updated;
  } else {
    topics.push(updated);
  }
  return {
    ...belief,
    topics,
    updatedAtIso: nowIso,
  };
};

const applyObservationToTopicBelief = (
  topic: TopicBelief,
  observation: InteractionObservation,
): TopicBelief => ({
  ...topic,
  interest: clampInterest(topic.interest + getInterestDelta(observation)),
  confidence: shiftConfidence(
    topic.confidence,
    getConfidenceDelta(observation),
  ),
});

const getInterestDelta = (observation: InteractionObservation): -1 | 0 | 1 => {
  if (observation === "positive") {
    return 1;
  }
  if (observation === "negative") {
    return -1;
  }
  return 0;
};

const getConfidenceDelta = (
  observation: InteractionObservation,
): -1 | 0 | 1 => {
  if (
    observation === "positive" ||
    observation === "negative" ||
    observation === "neutral"
  ) {
    return 1;
  }
  return 0;
};

const compareBeliefImportance = (
  left: TopicBelief,
  right: TopicBelief,
): number => {
  const score = beliefImportanceScore(right) - beliefImportanceScore(left);
  if (score !== 0) {
    return score;
  }
  return (
    Date.parse(right.lastObservedAtIso) - Date.parse(left.lastObservedAtIso)
  );
};

const beliefImportanceScore = (topic: TopicBelief): number =>
  topic.positiveCount * 4 +
  Math.abs(topic.interest) * 2 -
  topic.negativeCount * 2;

const pruneBelief = (belief: UserBelief): UserBelief => {
  const domainBeliefs = belief.topics.filter((topic) => !topic.topic);
  const topicBeliefs = belief.topics
    .filter((topic) => topic.topic)
    .sort(compareBeliefImportance)
    .slice(0, 16);
  return {
    ...belief,
    topics: [...domainBeliefs, ...topicBeliefs],
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

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");
