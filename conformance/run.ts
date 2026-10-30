// Start the mock and agent, then run: npm run conformance [-- scenario-name ...]
import { scenarios } from "./scenarios";
import { runConformanceSuite } from "./suite.js";
import type { ScenarioResult } from "./contracts.js";
import type { HarnessSupport } from "./client.js";

async function main() {
  const names = process.argv.slice(2);
  if (names.length === 1 && names[0] === "--list") return listScenarios();
  const results = await runConformanceSuite({
    scenarios: selectScenarios(names),
    agentBase: process.env.AGENT_BASE ?? "http://localhost:5050",
    mockBase: process.env.MOCK_BASE ?? "http://localhost:4010",
    onHarness: reportHarness,
    onResult: reportScenario,
  });
  reportSummary(results, names.length > 0);
}

function listScenarios() {
  for (const scenario of scenarios) {
    const requires = scenario.requires?.length
      ? ` [requires ${scenario.requires.join(", ")}]`
      : "";
    console.log(`${scenario.name}: ${scenario.description}${requires}`);
  }
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

function reportHarness({ capabilities, notes }: HarnessSupport) {
  console.log(
    `Mock harness: ${capabilities.size ? [...capabilities].join(", ") : "none"}`,
  );
  for (const note of notes) console.log(`  note: ${note}`);
}

function reportScenario({
  name,
  conversationId,
  failures,
  skipped,
}: ScenarioResult) {
  if (skipped) return console.log(`SKIP ${name} (${skipped})`);
  console.log(
    `${failures.length ? "FAIL" : "PASS"} ${name} (${conversationId})`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
}

function reportSummary(results: ScenarioResult[], explicitSelection: boolean) {
  const count = (outcome: (result: ScenarioResult) => boolean) =>
    results.filter(outcome).length;
  const skipped = count((result) => !!result.skipped);
  const failed = count((result) => !result.skipped && !!result.failures.length);
  const passed = results.length - skipped - failed;
  console.log(
    `Conformance: ${passed} passed, ${failed} failed, ${skipped} skipped.`,
  );
  // A scenario the user asked for by name must not silently pass by being skipped.
  if (failed || (explicitSelection && skipped)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(
    `CONFORMANCE FAILED: ${error instanceof Error ? error.message : "Unknown failure"}`,
  );
  process.exitCode = 1;
});
