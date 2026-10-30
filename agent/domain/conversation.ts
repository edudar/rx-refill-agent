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
  // Consecutive turns in which verification services were unavailable.
  unavailableTurns?: number;
  identityPrompt?: {
    fields: (keyof IdentityFactors)[];
    unansweredTurns: number;
  };
}

export interface AuthenticatingConversation
  extends ConversationBase, AuthenticationSession {
  phase: "authenticating";
}

export interface MedicationChoice {
  medId: string;
  name: string;
}

export interface PharmacyChoice {
  pharmacyId: string;
  name: string;
  address?: string;
}

// presented lists every destination shown to the patient for this refill; only
// those can be confirmed without first being proposed.
export type RefillState =
  | {
      step: "choosing_medication";
      options: MedicationChoice[];
      // A medication on hold while the patient considers another prescription.
      held?: MedicationChoice;
    }
  | {
      step: "choosing_pharmacy";
      medication: MedicationChoice;
      current: PharmacyChoice | null;
      options: PharmacyChoice[];
      presented: PharmacyChoice[];
    }
  | {
      step: "confirming";
      medication: MedicationChoice;
      current: PharmacyChoice | null;
      pharmacy: PharmacyChoice;
      presented: PharmacyChoice[];
    };

// Identity factors are not carried over. Without refill state, the workflow
// starts by resolving which medication the patient wants.
export interface VerifiedConversation extends ConversationBase {
  phase: "verified";
  patient: PatientRecord;
  refill?: RefillState;
  // Consecutive refill turns that made no progress, by kind.
  stalls?: { failure: number; unanswered: number };
}

export interface EndedConversation extends ConversationBase {
  phase: "ended";
  outcome: Exclude<AgentReplyState, "in_progress">;
  // The reply to every later message: what happened and what the patient can
  // do now, so thanks or "did it go through?" never get a repeated transcript.
  followUp: string;
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
