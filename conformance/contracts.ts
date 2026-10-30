import { z } from "zod";
import type { AgentReply } from "../agent/contracts/conversation.js";

export const recordedCallsSchema = z.array(
  z.object({
    seq: z.number().int(),
    method: z.string(),
    path: z.string(),
    body: z.unknown().optional(),
    query: z.record(z.string(), z.string()).optional(),
    status: z.number().int().optional(),
    response: z.unknown().optional(),
  }),
);
export type RecordedCall = z.infer<typeof recordedCallsSchema>[number];

// Local mock extensions under /__harness. The starter mock offers none of them, so scenarios
// that need one are skipped (not failed) when running against it.
export const harnessCapabilities = [
  "restore", // POST /__harness/restore isolates scenarios that change patient state
  "faults", // POST /__harness/faults injects service outages
  "call-outcomes", // /__calls records include response status and body
  "conformance-fixture", // the mock serves conformance/dataset.json and its clock
] as const;
export type HarnessCapability = (typeof harnessCapabilities)[number];

export interface ScenarioContext {
  conversationId: string;
  send(text: string): Promise<AgentReply>;
  calls(): Promise<RecordedCall[]>;
  fault(method: "GET" | "POST" | "PUT", path: string): Promise<void>;
  conversation(label: string): ScenarioContext;
  check(condition: boolean, message: string): void;
}

export interface ConformanceScenario {
  name: string;
  description: string;
  requires?: readonly HarnessCapability[];
  run(context: ScenarioContext): Promise<void>;
}

export interface ScenarioResult {
  name: string;
  conversationId: string;
  failures: string[];
  skipped?: string;
}
