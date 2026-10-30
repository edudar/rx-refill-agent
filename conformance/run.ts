// Start the mock and agent, then run: npm run conformance [-- scenario-name ...]
import { scenarios } from "./scenarios";
import { runConformanceSuite } from "./suite.js";
import type { ScenarioResult } from "./contracts.js";

async function main() {
  const names = process.argv.slice(2);
  if (names.length === 1 && names[0] === "--list") return listScenarios();
  const results = await runConformanceSuite({
    scenarios: selectScenarios(names),
    agentBase: process.env.AGENT_BASE ?? "http://localhost:5050",
    mockBase: process.env.MOCK_BASE ?? "http://localhost:4010",
    onResult: reportScenario,
  });
  reportSummary(results);
}

function listScenarios() {
  for (const scenario of scenarios)
    console.log(`${scenario.name}: ${scenario.description}`);
}

function selectScenarios(names: string[]) {
  const unknown = names.filter(
    (name) => !scenarios.some((scenario) => scenario.name === name),
  );
  if (unknown.length)
    throw new Error(
      `Unknown scenarios: ${unknown.join(", ")}. Run npm run conformance -- --list for available scenarios.`,
    );
  return names.length
    ? scenarios.filter((scenario) => names.includes(scenario.name))
    : scenarios;
}

function reportScenario({ name, conversationId, failures }: ScenarioResult) {
  console.log(
    `${failures.length ? "FAIL" : "PASS"} ${name} (${conversationId})`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
}

function reportSummary(results: ScenarioResult[]) {
  const passed = results.filter(
    (result) => result.failures.length === 0,
  ).length;
  console.log(`Conformance: ${passed}/${results.length} scenarios passed.`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(
    `CONFORMANCE FAILED: ${error instanceof Error ? error.message : "Unknown failure"}`,
  );
  process.exitCode = 1;
});
