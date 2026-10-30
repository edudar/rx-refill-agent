import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMockServer } from "./server.js";
import { devDataset } from "./data.dev.js";
import type { Dataset } from "./types.js";

// Dataset: DATASET_PATH > mock/dataset.json > built-in development seed.
const localJson = fileURLToPath(new URL("./dataset.json", import.meta.url));
const path =
  process.env.DATASET_PATH ?? (existsSync(localJson) ? localJson : null);
const dataset: Dataset = path
  ? JSON.parse(readFileSync(path, "utf8"))
  : devDataset;
const now = process.env.SIM_NOW ?? dataset.now;
const port = Number(process.env.PORT ?? 4010);
const server = createMockServer({
  dataset,
  now,
  ehrApiKey: process.env.EHR_API_KEY ?? "dev-ehr-key",
  pharmacyApiKey: process.env.PHARMACY_API_KEY ?? "dev-pharmacy-key",
});

server.listen(port, () => {
  console.log(`mock EHR+pharmacy on http://localhost:${port} (sim now=${now})`);
  if (path) console.log(`loaded dataset from ${path}`);
});
