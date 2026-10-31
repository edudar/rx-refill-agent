import OpenAI from "openai";
import type { ModelConfig } from "../config.js";

// Responses API counts reasoning tokens against max_output_tokens, so any effort
// other than "none" needs headroom beyond the visible structured output.
const REASONING_TOKEN_ALLOWANCE = 4_096;

// Typical calls take a few seconds, so one still waiting at 8 seconds has usually
// stalled; a fresh attempt helps more than waiting longer.
const ATTEMPT_TIMEOUT_MS = 8_000;
const RETRY_JITTER_MS = { min: 200, max: 600 };
// A longer server-requested wait would not fit the turn's time budget.
const MAX_RETRY_WAIT_MS = 2_000;

export interface ModelCallOptions {
  fetch?: typeof globalThis.fetch;
  onModelResolved?: ModelResolutionListener;
  onModelFailure?: ModelFailureListener;
  // Injected by tests to skip real waits between attempts.
  sleep?: (ms: number) => Promise<void>;
}

export function createOpenAIClient(
  options: Pick<ModelConfig, "apiKey"> & { fetch?: typeof globalThis.fetch },
) {
  return new OpenAI({
    apiKey: options.apiKey,
    timeout: ATTEMPT_TIMEOUT_MS,
    // Retries happen in reportingFailures so each attempt is logged and bounded.
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
  attempt?: number;
  willRetry?: boolean;
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

interface RetryPolicy {
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// Runs a model call, retrying transient failures up to `retries` times. Every
// failed attempt is reported; the last failure is rethrown unchanged for the
// caller's fallback. Model calls only read, so repeating one is safe.
export async function reportingFailures<T>(
  stage: string,
  listener: ModelFailureListener | undefined,
  run: () => Promise<T>,
  { retries = 0, sleep = wait, random = Math.random }: RetryPolicy = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const delay = attempt <= retries ? retryDelay(error, random) : undefined;
      try {
        listener?.({
          ...describeModelFailure(stage, error),
          attempt,
          willRetry: delay !== undefined,
        });
      } catch {
        // Reporting must not replace the original failure.
      }
      if (delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

// Connection failures, timeouts, 408, 409, 429, and 5xx can succeed on a second
// attempt; bad requests, bad keys, and incomplete or malformed output cannot.
function retryDelay(error: unknown, random: () => number) {
  if (!isTransient(error)) return undefined;
  const requested = requestedWait(error);
  if (requested !== undefined)
    return requested <= MAX_RETRY_WAIT_MS ? requested : undefined;
  const { min, max } = RETRY_JITTER_MS;
  return Math.round(min + random() * (max - min));
}

function isTransient(error: unknown) {
  if (error instanceof OpenAI.APIConnectionError) return true;
  if (!(error instanceof OpenAI.APIError) || error.status === undefined)
    return false;
  return [408, 409, 429].includes(error.status) || error.status >= 500;
}

function requestedWait(error: unknown) {
  if (!(error instanceof OpenAI.APIError)) return undefined;
  const milliseconds = headerNumber(error.headers, "retry-after-ms");
  if (milliseconds !== undefined) return milliseconds;
  const seconds = headerNumber(error.headers, "retry-after");
  return seconds === undefined ? undefined : seconds * 1_000;
}

// A missing or non-numeric value (such as an HTTP date) is ignored.
function headerNumber(headers: Headers | undefined, name: string) {
  const value = headers?.get(name);
  if (value === null || value === undefined || value.trim() === "")
    return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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
