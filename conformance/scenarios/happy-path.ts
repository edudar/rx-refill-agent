import type { ConformanceScenario } from "../contracts.js";
import { patientFixture } from "../fixtures.js";
import { completeRefill } from "../dialogue.js";

export const happyPath: ConformanceScenario = {
  name: "happy-path",
  description:
    "Authenticate Alice, retain Mission Rx, and successfully submit exactly one lisinopril refill.",
  async run(context) {
    await completeRefill(context, patientFixture("pat_001"));
  },
};
