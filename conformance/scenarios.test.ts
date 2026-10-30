import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { scenarios } from "./scenarios/index.js";
import { starterHappyPath, starterScript } from "./scenarios/starter.js";
import type { ScenarioContext } from "./contracts.js";

function idleAgent(failures: string[]): ScenarioContext {
  return {
    conversationId: "offline-oracle-check",
    send: async () => ({
      state: "in_progress",
      messages: [{ from: "agent", text: "Please share your ZIP." }],
    }),
    calls: async () => [],
    fault: async () => {},
    conversation: () => idleAgent(failures),
    check: (condition, message) => {
      if (!condition) failures.push(message);
    },
  };
}

test("scenario names are unique so CLI selection cannot silently run a different case", () => {
  const names = scenarios.map((scenario) => scenario.name);
  assert.equal(new Set(names).size, names.length);
});

test("registered scenarios execute offline and an idle agent cannot pass workflow or clinical cases", async () => {
  for (const scenario of scenarios) {
    const failures: string[] = [];
    await assert.doesNotReject(
      () => scenario.run(idleAgent(failures)),
      scenario.name,
    );
    // Doing nothing is valid only for the scenario that deliberately never supplies ZIP.
    if (scenario.name !== "missing-zip")
      assert.ok(
        failures.length > 0,
        `${scenario.name} passed without any service activity`,
      );
    else assert.deepEqual(failures, []);
  }
});

test("the starter script stays verbatim and runs against the starter mock without harness extensions", async () => {
  const original = readFileSync(
    new URL("./starter/run.ts", import.meta.url),
    "utf8",
  );
  for (const text of starterScript)
    assert.ok(original.includes(JSON.stringify(text)), text);
  assert.equal(scenarios[0], starterHappyPath);
  assert.equal(starterHappyPath.requires, undefined);
  for (const scenario of scenarios.slice(1))
    assert.ok(
      scenario.requires?.includes("conformance-fixture"),
      `${scenario.name} must declare the extended harness it relies on`,
    );
});
