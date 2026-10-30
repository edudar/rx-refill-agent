import { z } from "zod";
import type { Conversation } from "../domain/conversation.js";

export const patientMessageSchema = z.object({
  from: z.literal("patient"),
  text: z.string().trim().min(1).max(2_000),
});

export const agentMessageSchema = z.object({
  from: z.literal("agent"),
  text: z.string().min(1),
});

export const agentReplyStateSchema = z.enum([
  "in_progress",
  "complete",
  "escalated",
]);

export const agentReplySchema = z.object({
  messages: z.array(agentMessageSchema).min(1),
  state: agentReplyStateSchema,
});
export const conversationMessageSchema = z.discriminatedUnion("from", [
  patientMessageSchema,
  agentMessageSchema,
]);
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export type PatientMessage = z.infer<typeof patientMessageSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type AgentReplyState = z.infer<typeof agentReplyStateSchema>;
export type AgentReply = z.infer<typeof agentReplySchema>;
export type TurnHandler = (id: string, text: string) => Promise<AgentReply>;

export interface TurnInput {
  text: string;
  // True when an earlier step in this turn handed off. The message answered that
  // step's question, so it must not be read as an answer to this step's prompts.
  handedOff: boolean;
}

// The reply state is derived from the resulting phase, so a step cannot report a
// state that disagrees with it. "continue" hands the same turn to the next phase.
export interface StepResult {
  conversation: Conversation;
  messages: AgentMessage[];
  next: "reply" | "continue";
}

export type ConversationStep<C extends Conversation = Conversation> = (
  conversation: C,
  turn: TurnInput,
) => Promise<StepResult>;
