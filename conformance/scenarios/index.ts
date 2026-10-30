import type { ConformanceScenario, HarnessCapability } from "../contracts.js";
import { starterHappyPath } from "./starter.js";
import { happyPath } from "./happy-path.js";
import { missingZip } from "./missing-zip.js";
import { identityScenarios } from "./identity.js";
import { clinicalScenarios } from "./clinical.js";
import { medicationScenarios } from "./medications.js";
import { pharmacyScenarios } from "./pharmacies.js";
import { conversationScenarios } from "./conversation.js";
import { serviceFailureScenarios } from "./service-failures.js";

// Extended scenarios use fixture patients, restore state between runs, and inspect
// response outcomes in the call log.
const extendedHarness: readonly HarnessCapability[] = [
  "restore",
  "call-outcomes",
  "conformance-fixture",
];

export const scenarios: readonly ConformanceScenario[] = [
  starterHappyPath,
  ...requiring(extendedHarness, [
    happyPath,
    missingZip,
    ...identityScenarios,
    ...clinicalScenarios,
    ...medicationScenarios,
    ...pharmacyScenarios,
    ...conversationScenarios,
  ]),
  ...requiring([...extendedHarness, "faults"], serviceFailureScenarios),
];

function requiring(
  capabilities: readonly HarnessCapability[],
  group: readonly ConformanceScenario[],
): ConformanceScenario[] {
  return group.map((scenario) => ({
    ...scenario,
    requires: [...new Set([...capabilities, ...(scenario.requires ?? [])])],
  }));
}
