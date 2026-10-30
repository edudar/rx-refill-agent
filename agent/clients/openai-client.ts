import OpenAI from "openai";
import type { ModelConfig } from "../config.js";

// Responses API counts reasoning tokens against max_output_tokens, so any effort
// other than "none" needs headroom beyond the visible structured output.
const REASONING_TOKEN_ALLOWANCE = 4_096;

export interface ModelCallOptions {
  fetch?: typeof globalThis.fetch;
  onModelResolved?: ModelResolutionListener;
  onModelFailure?: ModelFailureListener;
}

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
  throw new ModelIncompleteError(stage, reason);
}

export class ModelIncompleteError extends Error {
  constructor(
    readonly stage: string,
    readonly reason: string,
  ) {
    super(`${stage} did not complete (${reason})`);
    this.name = "ModelIncompleteError";
  }
}

// Only error classes, API enums, and identifiers: never error messages, which can
// quote request content, so a failed call is diagnosable without exposing input.
export interface ModelFailure {
  stage: string;
  error: string;
  status?: number;
  type?: string;
  code?: string;
  reason?: string;
  requestId?: string;
  // OpenAI's x-ratelimit-* headers: which window was hit and when it resets.
  rateLimit?: Record<string, string>;
}

const RATE_LIMIT_HEADER_PREFIX = "x-ratelimit-";

export type ModelFailureListener = (failure: ModelFailure) => void;

export function describeModelFailure(
  stage: string,
  error: unknown,
): ModelFailure {
  const name = error instanceof Error ? error.name : "UnknownError";
  if (error instanceof OpenAI.APIError)
    return withoutEmpty({
      stage,
      error: error.constructor.name,
      status: error.status,
      type: error.type ?? undefined,
      code: error.code ?? undefined,
      requestId: error.requestID ?? undefined,
      rateLimit: rateLimitHeaders(error.headers),
    });
  if (error instanceof ModelIncompleteError)
    return { stage, error: name, reason: error.reason };
  return { stage, error: name };
}

// Header values are counts and durations (for example "200" or "6m0s").
function rateLimitHeaders(headers: Headers | undefined) {
  const limits: Record<string, string> = {};
  headers?.forEach((value, name) => {
    if (name.startsWith(RATE_LIMIT_HEADER_PREFIX))
      limits[name.slice(RATE_LIMIT_HEADER_PREFIX.length)] = value;
  });
  return Object.keys(limits).length ? limits : undefined;
}

function withoutEmpty(failure: ModelFailure): ModelFailure {
  return Object.fromEntries(
    Object.entries(failure).filter(([, value]) => value !== undefined),
  ) as ModelFailure;
}

// Reports a failed model call, then rethrows it unchanged for the caller's fallback.
export async function reportingFailures<T>(
  stage: string,
  listener: ModelFailureListener | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    try {
      listener?.(describeModelFailure(stage, error));
    } catch {
      // Reporting must not replace the original failure.
    }
    throw error;
  }
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

export function createModelFailureLogger(
  config: Pick<ModelConfig, "model">,
  write: (line: string) => void = console.log,
): ModelFailureListener {
  return (failure) => {
    try {
      write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "model_failed",
          model: config.model,
          ...failure,
        }),
      );
    } catch {
      // Logging must not affect the caller's fallback.
    }
  };
}
