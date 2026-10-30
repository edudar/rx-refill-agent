import { z } from "zod";
import type { AgentReply } from "../agent/contracts/conversation.js";

export const recordedCallsSchema = z.array(
  z.object({
    seq: z.number().int(),
    method: z.string(),
    path: z.string(),
    body: z.unknown().optional(),
  }),
);
export type RecordedCall = z.infer<typeof recordedCallsSchema>[number];

export interface ScenarioContext {
  conversationId: string;
  send(text: string): Promise<AgentReply>;
  calls(): Promise<RecordedCall[]>;
  check(condition: boolean, message: string): void;
}

export interface ConformanceScenario {
  name: string;
  description: string;
  run(context: ScenarioContext): Promise<void>;
}

export interface ScenarioResult {
  name: string;
  conversationId: string;
  failures: string[];
}
