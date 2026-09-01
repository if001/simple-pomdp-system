import {
  BackgroundInput,
  BackgroundInputSink,
  DialogueDecision,
  DialoguePlanningModel,
  InteractionLog,
  InteractionLogStore,
  InteractionObservation,
  ProactiveContextSource,
  TurnRecord,
  TurnRecordReader,
  TopicState,
  TopicStateSnapshot,
  TopicStateStore,
  ExploitResearchAgent,
  ExploitResearchResult,
} from "../domain/types";

export interface SimplePomdpSystemService {
  listTopicState(input: { userId: string }): Promise<TopicStateSnapshot | null>;
  dispatchNext(input: {
    botId: string;
    threadId: string;
    userId: string;
  }): Promise<BackgroundInput[]>;
}

export interface SimplePomdpSystemOptions {
  turnRecordReader: TurnRecordReader;
  topicStateStore: TopicStateStore;
  interactionLogStore: InteractionLogStore;
  plannerModel: DialoguePlanningModel;
  contextSources: ProactiveContextSource[];
  initialDomainCandidates?: string[];
  backgroundInputSink?: BackgroundInputSink;
  recentTurnLimit?: number;
  interactionLogLimit?: number;
  observeWindowTurns?: number;
  pendingTimeoutMs?: number;
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

  async listTopicState(input: {
    userId: string;
  }): Promise<TopicStateSnapshot | null> {
    return this.options.topicStateStore.getTopicState(input.userId);
  }

  async dispatchNext(input: {
    botId: string;
    threadId: string;
    userId: string;
  }): Promise<BackgroundInput[]> {
    logSimplePomdp(
      `dispatch start botId=${input.botId} threadId=${input.threadId} userId=${input.userId}`,
    );
    await this.refreshTopicStateFromPendingInteractions(input);

    const topicState =
      (await this.options.topicStateStore.getTopicState(input.userId)) ??
      createDefaultTopicState(input.userId, this.now().toISOString());
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
      `dispatch state threadId=${input.threadId} topics=${topicState.topics.length} logs=${interactionLogs.length} pending=${pendingLogs.length}`,
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
    const recentTurns =
      await this.options.turnRecordReader.listRecentTurnRecords({
        botId: input.botId,
        threadId: input.threadId,
        limit: this.recentTurnLimit,
      });
    const proactiveContext = await loadProactiveContext(
      this.options.contextSources,
      input,
    );
    const planningNow = this.now();
    const plannerSignals = buildPlannerSignals(
      recentTurns,
      interactionLogs,
      planningNow,
      input.botId,
      input.threadId,
    );
    logSimplePomdp(
      `planning input threadId=${input.threadId} recentTurns=${recentTurns.length} contextItems=${proactiveContext.length} userInactivity=${plannerSignals.hoursSinceLastUserTurnBucket} agentInactivity=${plannerSignals.hoursSinceLastAgentInitiatedBucket}`,
    );
    const decision = await this.decideNextInteraction({
      proactiveContext,
      topicState,
      triedTopics: interactionLogs.flatMap((log) =>
        [log.targetDomain, log.targetTopic].filter(
          (value): value is string => Boolean(value),
        ),
      ),
      plannerSignals,
      initialDomainCandidates: this.initialDomainCandidates,
      now: planningNow,
    });
    logSimplePomdp(
      `planning result threadId=${input.threadId} kind=${decision.kind}`,
    );
    logSimplePomdp(
      `decision\n` +
        `kind:${decision.kind}\n` +
        `reason: ${decision.reason}\n` +
        `targetDomain:${decision.targetDomain}\n` +
        `targetTopic:${decision.targetTopic}`,
    );
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
            topicState,
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

  private async refreshTopicStateFromPendingInteractions(input: {
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
    let topicState =
      (await this.options.topicStateStore.getTopicState(input.userId)) ??
      createDefaultTopicState(input.userId, this.now().toISOString());
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
      if (completedLog.observation === "no_response") {
        logSimplePomdp(
          `topic state unchanged threadId=${input.threadId} interactionId=${log.id} reason=no_response`,
        );
        continue;
      }
      const nextTopicState = applyInteractionObservationToTopicState(
        topicState,
        completedLog,
        this.now().toISOString(),
      );
      await this.options.topicStateStore.saveTopicState(nextTopicState);
      logSimplePomdp(
        `topic state saved threadId=${input.threadId} interactionId=${log.id} topics=${nextTopicState.topics.length}`,
      );
      topicState = nextTopicState;
    }
  }

  private async decideNextInteraction(input: {
    proactiveContext: string[];
    topicState: TopicStateSnapshot;
    triedTopics: string[];
    plannerSignals: PlannerSignals;
    initialDomainCandidates: string[];
    now: Date;
  }): Promise<DialogueDecision> {
    const raw_prompt = JSON.stringify({
      instruction: [
        "currentSituation と proactiveContext を読んでください。",
        "現在の時刻・曜日は、話題を出す自然さと過去のおすすめをフォローする時期の判断にだけ使ってください。",
        "proactiveContext 内の interaction の時刻・話題・反応を比較し、無反応の理由は仮説として扱ってください。",
        "initialDomainCandidates は、初対面で広く探るための幅広い領域候補です。",
        "assessment=interested の topic は refine/exploit を優先できます。",
        "assessment=avoid の topic は候補にしないでください。",
        "最終的な DialogueDecision を 1 件だけ返してください。",
      ].join(" "),
      currentSituation: buildCurrentSituation(input.now),
      proactiveContext: input.proactiveContext,
      plannerSignals: input.plannerSignals,
      initialDomainCandidates: input.initialDomainCandidates.slice(0, 24),
    });
    console.log("[decideNextInteraction] raw_prompt: ", raw_prompt);
    const parsed =
      await this.options.plannerModel.generateJson<RawDialogueDecision>(
        [
          "あなたは POMDP ベースの proactive dialogue planner です。",
          "今この時点で行う判断を 1 件だけ返してください。kind は exploit, refine, explore のいずれかです。",
          "explore は broad domain 候補から、最近の会話に偏りすぎず未知の関心を低コストに確認します。",
          "refine は既に反応のあった domain/topic を少し絞る候補です。",
          "exploit は十分に方向性が見えている domain/topic に価値提供する候補です。",
          "assessment=interested の topic は refine や exploit に寄せてください。",
          "assessment=avoid の topic は再提示しないでください。",
          "no_response は関心がないことを意味しません。単独の no_response で関心や通知許容度を下げないでください。",
          "無反応がある場合は、特定話題だけか、同じ話題の反復か、時間帯に偏るか、メッセージが重いか、材料不足かを最近の履歴から比較してください。理由を断定せず、次の判断では一度に話題・時刻・提示方法の 1 要素だけを変えてください。",
          "異なる話題でも同じ時間帯に無反応なら提示を短くし、同じ話題だけが続いて無反応なら別領域の短い explore を優先してください。以前 positive だった話題の一度の無反応は関心低下とみなさないでください。",
          "以前おすすめした場所・物・行動を尋ねる場合は、proactiveContext から実際におすすめした事実を確認し、経過時間と現在の曜日・時間帯が自然な場合だけ、訪れた・試したと決めつけず短く尋ねてください。",
          "必ず kind, targetDomain, optional targetTopic, messageIntent, reason を返してください。reason には現在の状況と履歴に基づく短い判断根拠を書いてください。",
          "JSON のみを返してください。",
        ].join(" "),
        raw_prompt,
      );
    const decision = normalizeDialogueDecision(parsed);
    const requiresInitialExplore =
      input.topicState.topics.length === 0 && input.triedTopics.length === 0;
    return decision &&
      !isAvoidedDecision(decision, input.topicState) &&
      (!requiresInitialExplore || decision.kind === "explore")
      ? decision
      : createFallbackExploreDecision(
          input.initialDomainCandidates,
          input.topicState,
          input.triedTopics,
        );
  }
}

export const createSimplePomdpSystemService = (
  options: SimplePomdpSystemOptions,
): SimplePomdpSystemService => new DefaultSimplePomdpSystemService(options);

const loadProactiveContext = async (
  sources: ProactiveContextSource[],
  input: { botId: string; threadId: string; userId: string },
): Promise<string[]> => {
  const context: string[] = [];
  for (const source of sources) {
    try {
      const loaded = await source.load(input);
      context.push(...loaded.filter((item) => item.trim().length > 0));
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Proactive context source "${source.name}" failed: ${detail}`,
        { cause: error },
      );
    }
  }
  return context;
};

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
    (turn) =>
      turn.kind === "human" &&
      turn.sourceInteractionId === log.id &&
      Date.parse(turn.createdAtIso) > interactionAt,
  );

  const observedTurns = subsequentTurns.slice(0, log.observeWindowTurns);
  const observedMessages = observedTurns
    .flatMap((turn) => turn.messages)
    .filter((message) => message.role === "user")
    .map((message) => `[${message.role}] ${message.content.trim()}`)
    .filter(Boolean);
  const hasUserMessage = observedMessages.length > 0;

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

const applyInteractionObservationToTopicState = (
  state: TopicStateSnapshot,
  interactionLog: InteractionLog,
  nowIso: string,
): TopicStateSnapshot => {
  const topic = interactionLog.targetTopic ?? interactionLog.targetDomain;
  if (!topic) {
    return state;
  }
  const assessment = observationToAssessment(interactionLog.observation);
  if (!assessment) {
    return state;
  }
  const normalizedTopic = topic.trim();
  const index = state.topics.findIndex(
    (item) => item.topic.toLowerCase() === normalizedTopic.toLowerCase(),
  );
  const updated: TopicState = {
    topic: normalizedTopic,
    assessment,
    evidence:
      interactionLog.feedbackNote.trim() ||
      `proactive interaction was classified as ${interactionLog.observation}`,
    lastTriedAt: interactionLog.createdAtIso,
  };
  const topics = [...state.topics];
  if (index >= 0) {
    topics[index] = updated;
  } else {
    topics.push(updated);
  }
  return {
    ...state,
    topics: topics.slice(-64),
    updatedAtIso: nowIso,
  };
};

const logSimplePomdp = (message: string): void => {
  process.stdout.write(`[simple-pomdp] ${message}\n`);
};

const createDefaultTopicState = (
  userId: string,
  nowIso: string,
): TopicStateSnapshot => ({
  userId,
  topics: [],
  updatedAtIso: nowIso,
});

const observationToAssessment = (
  observation: InteractionObservation,
): TopicState["assessment"] | null => {
  if (observation === "positive") {
    return "interested";
  }
  if (observation === "negative") {
    return "avoid";
  }
  if (observation === "neutral") {
    return "possible";
  }
  return null;
};

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
    .filter((turn) => turn.kind === "human")
    .flatMap((turn) => turn.messages)
    .filter((message) => message.role === "user")
    .map((message) => message.timestampIso)
    .sort()
    .at(-1);
  const lastAgentInteractionIso = interactionLogs
    .filter(
      (log) => log.botId === botId && log.threadId === threadId,
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

const buildBackgroundInstruction = (
  decision: DialogueDecision,
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

const isAvoidedDecision = (
  decision: DialogueDecision,
  state: TopicStateSnapshot,
): boolean => {
  const candidates = [decision.targetDomain, decision.targetTopic]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim().toLowerCase());
  return state.topics.some(
    (topic) =>
      topic.assessment === "avoid" &&
      candidates.includes(topic.topic.trim().toLowerCase()),
  );
};

const createFallbackExploreDecision = (
  initialDomainCandidates: string[],
  state: TopicStateSnapshot,
  triedTopics: string[],
): DialogueDecision => {
  const known = new Set(
    [...state.topics.map((topic) => topic.topic), ...triedTopics].map((topic) =>
      topic.trim().toLowerCase(),
    ),
  );
  const allowed = initialDomainCandidates.filter((candidate) => {
    const normalized = candidate.trim().toLowerCase();
    return (
      normalized.length > 0 &&
      !state.topics.some(
        (topic) =>
          topic.assessment === "avoid" &&
          topic.topic.trim().toLowerCase() === normalized,
      )
    );
  });
  const targetDomain =
    allowed.find((candidate) => !known.has(candidate.trim().toLowerCase())) ??
    allowed[0] ??
    "general interests";
  return {
    kind: "explore",
    targetDomain,
    messageIntent: `${targetDomain}について関心があるか短く尋ねる`,
    reason: "有効な候補がないため、未試行の表面的な領域を探索する",
  };
};

const formatRecentTurns = (turns: TurnRecord[]): string[] =>
  turns
    .flatMap((turn) => {
      if (turn.kind === "delegation") {
        return [];
      }
      return turn.messages.filter((message) =>
        turn.kind === "proactive"
          ? message.role === "assistant"
          : message.role === "user" || message.role === "assistant",
      );
    })
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

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");
