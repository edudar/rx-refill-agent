import { randomUUID } from "node:crypto";
import { createConformanceClient } from "./client.js";
import type { ConformanceScenario, ScenarioResult } from "./contracts.js";

export async function runConformanceSuite(options: {
  scenarios: readonly ConformanceScenario[];
  agentBase: string;
  mockBase: string;
  fetch?: typeof globalThis.fetch;
  onResult?: (result: ScenarioResult) => void;
}): Promise<ScenarioResult[]> {
  const client = createConformanceClient(options);
  await client.health();
  const results: ScenarioResult[] = [];

  // The mock request log is global, so scenarios must run sequentially.
  for (const scenario of options.scenarios) {
    const result: ScenarioResult = {
      name: scenario.name,
      conversationId: `${scenario.name}-${randomUUID()}`,
      failures: [],
    };
    try {
      await client.reset();
      await scenario.run(
        client.context(result.conversationId, (condition, message) => {
          if (!condition) result.failures.push(message);
        }),
      );
    } catch (error) {
      result.failures.push(
        error instanceof Error ? error.message : "Unknown scenario failure",
      );
    }
    results.push(result);
    options.onResult?.(result);
  }
  return results;
}
