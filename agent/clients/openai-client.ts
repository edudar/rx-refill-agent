import OpenAI from "openai";
import type { ModelConfig } from "../config.js";

// Responses API counts reasoning tokens against max_output_tokens, so any effort
// other than "none" needs headroom beyond the visible structured output.
const REASONING_TOKEN_ALLOWANCE = 4_096;

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

export function outputTokenLimit(
  visibleTokens: number,
  reasoning: ModelConfig["reasoning"],
) {
  return reasoning.effort === "none"
    ? visibleTokens
    : visibleTokens + REASONING_TOKEN_ALLOWANCE;
}

// The reason is an API enum (for example max_output_tokens), never model or patient text.
export function assertCompleted(
  stage: string,
  response: {
    status?: string | null;
    incomplete_details?: { reason?: string } | null;
  },
  parsed: unknown,
): asserts parsed {
  if (response.status === "completed" && parsed) return;
  const reason =
    response.status === "completed"
      ? "no parsed output"
      : (response.incomplete_details?.reason ?? response.status ?? "unknown");
  throw new Error(`${stage} did not complete (${reason})`);
}

export type ModelResolutionListener = (resolvedModel: string) => void;

// Records the snapshot an alias such as gpt-6-luna resolved to, once per distinct
// snapshot, so any run (including conformance) documents the exact model version.
export function createModelResolutionLogger(
  config: Pick<ModelConfig, "model" | "reasoning">,
  write: (line: string) => void = console.log,
): ModelResolutionListener {
  const seen = new Set<string>();
  return (resolvedModel) => {
    if (seen.has(resolvedModel)) return;
    seen.add(resolvedModel);
    try {
      write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "model_resolved",
          configuredModel: config.model,
          resolvedModel,
          reasoningEffort: config.reasoning.effort,
        }),
      );
    } catch {
      // Logging must not affect a model call that already succeeded.
    }
  };
}
