import type { ConformanceScenario } from "../contracts.js";
import { happyPath } from "./happy-path.js";
import { missingZip } from "./missing-zip.js";

export const scenarios: readonly ConformanceScenario[] = [
  happyPath,
  missingZip,
];
