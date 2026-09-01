export type { TurnRecord, TurnRecordReader } from "@chat-agent/memory-system";

export type TopicInterest = -2 | -1 | 0 | 1 | 2;
export type TopicConfidence = "low" | "medium" | "high";
export type InitiationTolerance = "unknown" | "low" | "medium" | "high";

export interface TopicBelief {
  id: string;
  domain: string;
  topic?: string;
  interest: TopicInterest;
  confidence: TopicConfidence;
  attemptCount: number;
  positiveCount: number;
  negativeCount: number;
  lastObservedAtIso: string;
}

export interface UserBelief {
  userId: string;
  topics: TopicBelief[];
  initiationTolerance: InitiationTolerance;
  initiationPositiveCount: number;
  initiationNegativeCount: number;
  initiationNoResponseCount: number;
  updatedAtIso: string;
}

export type DialogueDecisionKind =
  | "exploit"
  | "refine"
  | "explore"
  | "do_nothing";
export type ActiveDialogueDecisionKind = Exclude<
  DialogueDecisionKind,
  "do_nothing"
>;
export type DialogueProbeType = "breadth" | "depth" | "exploit";

export type DialogueDecision =
  | {
      kind: "do_nothing";
      reason: string;
    }
  | {
      kind: ActiveDialogueDecisionKind;
      targetDomain: string;
      targetTopic?: string;
      messageIntent: string;
      reason: string;
    };

export interface InteractionLog {
  id: string;
  userId: string;
  botId: string;
  threadId: string;
  candidateKind: DialogueDecisionKind;
  /** Legacy field. New decisions derive the exploration style from kind. */
  probeType?: DialogueProbeType;
  targetDomain?: string;
  targetTopic?: string;
  message: string;
  status: InteractionStatus;
  observation: InteractionObservation;
  feedbackNote: string;
  supportSummary?: string;
  articleIds?: string[];
  sourceUrls?: string[];
  observeWindowTurns: number;
  createdAtIso: string;
  resolvedAtIso?: string;
}

export type InteractionObservation =
  | "positive"
  | "negative"
  | "neutral"
  | "no_response"
  | "unknown";

export type InteractionStatus = "pending" | "resolved" | "expired";

export interface BackgroundInput {
  botId: string;
  threadId: string;
  text: string;
  sourceInteractionId: string;
}

export interface KnowledgeAccessSearchResultItem {
  articleId: string;
  score: number;
  title: string;
  summary: string;
  tags: string[];
  url: string;
}

export interface KnowledgeAccessSavedArticle {
  id: string;
  url: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  rawMarkdown: string;
  createdAt: Date;
}

export interface KnowledgeAccessWebListItem {
  rank: number;
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
}

export interface KnowledgeAccessWebPage {
  url: string;
  title: string;
  markdown: string;
}

export interface KnowledgeAccessService {
  searchSavedKnowledge(input: {
    query: string;
    limit?: number;
    minScore?: number;
  }): Promise<KnowledgeAccessSearchResultItem[]>;
  getSavedArticle(input: {
    articleId?: string;
    url?: string;
  }): Promise<KnowledgeAccessSavedArticle | null>;
  webList(input: {
    query: string;
    limit: number;
  }): Promise<KnowledgeAccessWebListItem[]>;
  webPage(input: {
    url: string;
  }): Promise<KnowledgeAccessWebPage>;
  saveWebKnowledge(input: {
    botId: string;
    threadId?: string;
    url: string;
  }): Promise<{
    articleId: string;
    title: string;
    summary: string;
    url: string;
  }>;
}

export interface ExploitResearchResult {
  summary: string;
  articleIds: string[];
  sourceUrls: string[];
  notes: string[];
}

export interface ExploitResearchAgent {
  research(input: {
    botId: string;
    threadId: string;
    userId: string;
    targetDomain: string;
    targetTopic?: string;
    recentTurns: string[];
    belief: UserBelief;
  }): Promise<ExploitResearchResult>;
}

export interface DialoguePlanningModel {
  generateJson<T>(systemPrompt: string, userPrompt: string): Promise<T>;
}

export interface UserBeliefStore {
  getUserBelief(userId: string): Promise<UserBelief | null>;
  saveUserBelief(belief: UserBelief): Promise<void>;
}

export interface InteractionLogStore {
  listRecentInteractionLogs(input: {
    userId: string;
    limit: number;
  }): Promise<InteractionLog[]>;
  saveInteractionLog(log: InteractionLog): Promise<void>;
}

export interface BackgroundInputSink {
  enqueue(input: BackgroundInput): Promise<void>;
}

export interface PomdpContextProvider {
  getContext(input: {
    botId: string;
    threadId: string;
    userId: string;
  }): Promise<{
    recentContextSummary?: string;
    notes?: string[];
  }>;
}
