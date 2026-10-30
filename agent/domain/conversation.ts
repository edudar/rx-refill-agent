import type { PatientRecord } from "../contracts/ehr.js";
import type {
  AgentReply,
  AgentReplyState,
  ConversationMessage,
} from "../contracts/conversation.js";
import type { IdentityFactors } from "./identity.js";

// What the patient asked for, as they wrote it. It is never resolved against
// records until identity is verified.
export interface RefillIntent {
  medicationMention: string;
}

export interface ConversationBase {
  history: ConversationMessage[];
  lastReply?: AgentReply;
  lastPrompt: string;
  pendingIntent?: RefillIntent;
  createdAt: number;
  touchedAt: number;
}

export interface AuthenticationSession {
  factors: IdentityFactors;
  failedMatches: number;
  lastFailedFactors?: string;
  identityPrompt?: {
    fields: (keyof IdentityFactors)[];
    unansweredTurns: number;
  };
}

export interface AuthenticatingConversation
  extends ConversationBase, AuthenticationSession {
  phase: "authenticating";
}

// Entry point for the refill workflow; identity factors are not carried over.
export interface VerifiedConversation extends ConversationBase {
  phase: "verified";
  patient: PatientRecord;
}

export interface EndedConversation extends ConversationBase {
  phase: "ended";
  outcome: Exclude<AgentReplyState, "in_progress">;
}

export type Conversation =
  AuthenticatingConversation | VerifiedConversation | EndedConversation;
export type ConversationPhase = Conversation["phase"];

export function conversationBase({
  history,
  lastReply,
  lastPrompt,
  pendingIntent,
  createdAt,
  touchedAt,
}: ConversationBase): ConversationBase {
  return {
    history,
    lastReply,
    lastPrompt,
    pendingIntent,
    createdAt,
    touchedAt,
  };
}

export function replyState(conversation: Conversation): AgentReplyState {
  return conversation.phase === "ended" ? conversation.outcome : "in_progress";
}
