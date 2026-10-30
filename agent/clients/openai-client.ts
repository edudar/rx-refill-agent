import OpenAI from "openai";
import type { ModelConfig } from "../config.js";

export function createOpenAIClient(
  options: Pick<ModelConfig, "apiKey"> & { fetch?: typeof globalThis.fetch },
) {
  return new OpenAI({
    apiKey: options.apiKey,
    timeout: 15_000,
    maxRetries: 0,
    fetch: options.fetch,
  });
}
