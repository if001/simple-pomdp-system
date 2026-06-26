export type ChatRole = "system" | "user" | "assistant";

export interface TurnMessage {
  role: ChatRole;
  content: string;
  timestampIso: string;
}

export interface TurnRecord {
  id?: string;
  botId: string;
  threadId: string;
  messages: TurnMessage[];
  createdAtIso: string;
}

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
  note: string;
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

export type DialogueCandidateKind =
  | "exploit"
  | "refine"
  | "explore"
  | "do_nothing";
export type CandidateLevel = "low" | "medium" | "high";
export type DialogueProbeType = "breadth" | "depth" | "exploit";

export interface DialogueCandidate {
  kind: DialogueCandidateKind;
  probeType?: DialogueProbeType;
  targetDomain?: string;
  targetTopic?: string;
  intent: string;
  draftMessage?: string;
  expectedBenefit: CandidateLevel;
  expectedRisk: CandidateLevel;
  reason: string;
}

export type InteractionObservation =
  | "positive"
  | "negative"
  | "neutral"
  | "no_response"
  | "unknown";

export type InteractionStatus = "pending" | "resolved" | "expired";

export interface InteractionLog {
  id: string;
  userId: string;
  botId: string;
  threadId: string;
  candidateKind: DialogueCandidateKind;
  probeType?: DialogueProbeType;
  targetDomain?: string;
  targetTopic?: string;
  message: string;
  status: InteractionStatus;
  observation: InteractionObservation;
  feedbackNote: string;
  observeWindowTurns: number;
  createdAtIso: string;
  resolvedAtIso?: string;
}

export interface BeliefUpdate {
  targetDomain: string;
  targetTopic?: string;
  interestDelta: -1 | 0 | 1;
  confidenceDelta: -1 | 0 | 1;
  initiationToleranceDelta: -1 | 0 | 1;
  note: string;
}

export interface BackgroundInput {
  botId: string;
  threadId: string;
  text: string;
  sourceInteractionId: string;
}

export interface DialoguePlanningModel {
  generateJson<T>(systemPrompt: string, userPrompt: string): Promise<T>;
}

export interface TurnRecordStore {
  appendTurnRecord(turn: TurnRecord): Promise<void>;
  listRecentTurnRecords(input: {
    botId: string;
    threadId: string;
    limit: number;
  }): Promise<TurnRecord[]>;
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
