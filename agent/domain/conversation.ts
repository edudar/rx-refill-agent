import type { PatientRecord } from "../contracts/ehr.js";
import type { AgentReply, AgentReplyState } from "../contracts/conversation.js";
import type { IdentityFactors } from "./identity.js";

export interface AuthenticationSession {
  factors: IdentityFactors;
  failedMatches: number;
  lastFailedFactors?: string;
  patient?: PatientRecord;
  identityPrompt?: {
    fields: (keyof IdentityFactors)[];
    unansweredTurns: number;
  };
}

export interface Conversation extends AuthenticationSession {
  state: AgentReplyState;
  lastReply?: AgentReply;
  lastPrompt: string;
  createdAt: number;
  touchedAt: number;
}
