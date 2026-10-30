import { randomUUID } from "node:crypto";
import { createConformanceClient, type HarnessSupport } from "./client.js";
import type { ConformanceScenario, ScenarioResult } from "./contracts.js";

type ConformanceClient = ReturnType<typeof createConformanceClient>;

export async function runConformanceSuite(options: {
  scenarios: readonly ConformanceScenario[];
  agentBase: string;
  mockBase: string;
  fetch?: typeof globalThis.fetch;
  onHarness?: (harness: HarnessSupport) => void;
  onResult?: (result: ScenarioResult) => void;
}): Promise<ScenarioResult[]> {
  const client = createConformanceClient(options);
  await client.health();
  const harness = await client.harness();
  options.onHarness?.(harness);
  const results: ScenarioResult[] = [];
  // The mock state is global, so scenarios must run sequentially.
  for (const scenario of options.scenarios) {
    const result = await runScenario(client, harness, scenario);
    results.push(result);
    options.onResult?.(result);
  }
  return results;
}

async function runScenario(
  client: ConformanceClient,
  harness: HarnessSupport,
  scenario: ConformanceScenario,
): Promise<ScenarioResult> {
  const result: ScenarioResult = {
    name: scenario.name,
    conversationId: `${scenario.name}-${randomUUID()}`,
    failures: [],
  };
  const missing = (scenario.requires ?? []).filter(
    (capability) => !harness.capabilities.has(capability),
  );
  if (missing.length) {
    result.skipped = `mock lacks ${missing.join(", ")}`;
    return result;
  }
  try {
    await client.reset(harness);
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
  return result;
}
