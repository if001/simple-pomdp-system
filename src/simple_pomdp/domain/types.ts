export type { TurnRecord, TurnRecordReader } from "@chat-agent/memory-system";

export type TopicAssessment = "unknown" | "avoid" | "possible" | "interested";

export interface TopicState {
  topic: string;
  assessment: TopicAssessment;
  evidence: string;
  lastTriedAt?: string;
}

export interface TopicStateSnapshot {
  userId: string;
  topics: TopicState[];
  updatedAtIso: string;
}

export type DialogueDecisionKind = "exploit" | "refine" | "explore";
export type ProactiveTrigger = "conversation" | "scheduled";
export type DialogueProbeType = "breadth" | "depth" | "exploit";

export interface DialogueDecision {
  kind: DialogueDecisionKind;
  targetDomain: string;
  targetTopic?: string;
  messageIntent: string;
  reason: string;
}

export interface InteractionLog {
  id: string;
  userId: string;
  botId: string;
  threadId: string;
  candidateKind: DialogueDecisionKind;
  trigger: ProactiveTrigger;
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

interface ProactiveTriggerOutputBase {
  botId: string;
  threadId: string;
  text: string;
  sourceInteractionId: string;
}

export interface ConversationTopicOutput extends ProactiveTriggerOutputBase {
  trigger: "conversation";
}

export interface ScheduledAgentInput extends ProactiveTriggerOutputBase {
  trigger: "scheduled";
}

export type ProactiveTriggerOutput =
  | ConversationTopicOutput
  | ScheduledAgentInput;

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
    topicState: TopicStateSnapshot;
  }): Promise<ExploitResearchResult>;
}

export interface DialoguePlanningModel {
  generateJson<T>(systemPrompt: string, userPrompt: string): Promise<T>;
}

export interface TopicStateStore {
  getTopicState(userId: string): Promise<TopicStateSnapshot | null>;
  saveTopicState(state: TopicStateSnapshot): Promise<void>;
}

export interface InteractionLogStore {
  listRecentInteractionLogs(input: {
    userId: string;
    limit: number;
  }): Promise<InteractionLog[]>;
  saveInteractionLog(log: InteractionLog): Promise<void>;
}

export interface BackgroundInputSink {
  enqueue(input: ScheduledAgentInput): Promise<void>;
}

export interface ProactiveContextInput {
  botId: string;
  threadId: string;
  userId: string;
}

export interface ProactiveContextSource {
  name: string;
  load(input: ProactiveContextInput): Promise<string[]>;
}

export interface UserMemoryItem {
  text: string;
  createdAtIso?: string;
}

export interface UserMemoryReader {
  listRecentUserMemory(input: {
    botId: string;
    userId: string;
    limit: number;
  }): Promise<UserMemoryItem[]>;
}
