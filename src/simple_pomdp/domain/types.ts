import type { KnowledgeAccessService } from "@chat-agent/knowledge-access";

export type { TurnRecord, TurnRecordReader } from "@chat-agent/memory-system";
export type { KnowledgeAccessService } from "@chat-agent/knowledge-access";

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

export type ConversationOpportunitySkipReason =
  | "active_conversation"
  | "confirmation"
  | "correction"
  | "work_in_progress"
  | "error"
  | "assessment_unavailable";

export type ConversationOpportunityAssessment =
  | { kind: "opportunity"; reason: string }
  | {
      kind: "skip";
      reason: ConversationOpportunitySkipReason;
      detail: string;
    };

export interface ConversationOpportunityAssessor {
  assess(input: {
    botId: string;
    threadId: string;
    userId: string;
    currentContext: string;
    recentTurns: string[];
  }): Promise<ConversationOpportunityAssessment>;
}

export interface DialogueDecision {
  kind: DialogueDecisionKind;
  targetDomain: string;
  targetTopic?: string;
  matchedExistingTopic?: string;
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
  getTopicState(input: {
    botId: string;
    userId: string;
  }): Promise<TopicStateSnapshot | null>;
  saveTopicState(input: {
    botId: string;
    userId: string;
    state: TopicStateSnapshot;
  }): Promise<void>;
}

export interface InteractionLogStore {
  listRecentInteractionLogs(input: {
    botId: string;
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
  /** Compact recent-turn context supplied by the service; not persisted. */
  currentContext?: string;
}

export interface ProactiveContextSource {
  name: string;
  load(input: ProactiveContextInput): Promise<string[]>;
}

export interface MemoryServiceReader {
  search(input: {
    botId: string;
    threadId: string;
    userId: string;
    query: string;
    scopes: Array<"conversation_history" | "user_memory">;
    limits?: Partial<Record<"conversation_history" | "user_memory", number>>;
  }): Promise<{
    conversationHistory?:
      | { status: "found"; data: Array<{ occurredAt: string; excerpt: string }> }
      | { status: "not_found" }
      | { status: "unavailable"; reason?: string };
    userMemory?:
      | { status: "found"; data: Array<{ note: string }> }
      | { status: "not_found" }
      | { status: "unavailable"; reason?: string };
  }>;
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
