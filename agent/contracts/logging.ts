import type { AgentReply } from "./conversation.js";

interface ConversationLogContext {
  timestamp: string;
  conversationId: string;
  turnId: string;
}

export type ConversationLogEvent = ConversationLogContext &
  (
    | { event: "patient_message"; text: string }
    | { event: "agent_reply"; reply: AgentReply; durationMs: number }
    | { event: "turn_error"; durationMs: number }
  );

export type ConversationLogger = (event: ConversationLogEvent) => void;
