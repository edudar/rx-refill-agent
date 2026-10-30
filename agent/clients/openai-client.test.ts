import assert from "node:assert/strict";
import test from "node:test";
import { createIdentityExtractor } from "./identity-extractor.js";
import {
  createModelFailureLogger,
  reportingFailures,
  type ModelFailure,
} from "./openai-client.js";
import { createRefillInterpreter } from "./refill-interpreter.js";
import { createResponseGenerator } from "./response-generator.js";

const patientText = "Alice Nguyen, DOB 1988-03-12";

function rateLimited() {
  return Response.json(
    {
      error: {
        message: `Rate limit reached while processing "${patientText}"`,
        type: "requests",
        code: "rate_limit_exceeded",
      },
    },
    {
      status: 429,
      headers: {
        "x-request-id": "req_123",
        "x-ratelimit-limit-requests": "200",
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-reset-requests": "6m0s",
        "x-ratelimit-limit-tokens": "40000",
        "x-ratelimit-remaining-tokens": "39488",
        "x-ratelimit-reset-tokens": "768ms",
      },
    },
  );
}

function incomplete() {
  return Response.json({
    id: "resp-test",
    object: "response",
    created_at: 0,
    model: "test-model",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [],
  });
}

function callers(fetch: typeof globalThis.fetch, failures: ModelFailure[]) {
  const options = {
    apiKey: "test-key",
    model: "test-model",
    reasoning: { effort: "none" as const },
    fetch,
    onModelFailure: (failure: ModelFailure) => failures.push(failure),
  };
  return [
    () =>
      createIdentityExtractor(options)({
        text: patientText,
        factors: {},
        lastPrompt: "",
      }),
    () =>
      createResponseGenerator(options)({
        decision: {
          action: "request_identity",
          acceptedFields: [],
          newlyReceivedFields: [],
          requestedFields: ["zip"],
          invalidFields: [],
          failedMatchAttempts: 0,
          unansweredRequests: 0,
        },
        messages: [{ from: "patient", text: patientText }],
      }),
    () =>
      createRefillInterpreter(options)({
        text: patientText,
        question: "confirm_refill",
        lastPrompt: "",
      }),
  ];
}

test("every model call reports API failures by status and enum, never by message", async () => {
  const failures: ModelFailure[] = [];
  for (const call of callers(async () => rateLimited(), failures))
    await assert.rejects(call(), /Rate limit/);
  assert.deepEqual(
    failures.map(({ stage }) => stage),
    ["Identity extraction", "Response generation", "Refill interpretation"],
  );
  for (const failure of failures)
    assert.deepEqual(
      { ...failure, stage: undefined },
      {
        stage: undefined,
        error: "RateLimitError",
        status: 429,
        type: "requests",
        code: "rate_limit_exceeded",
        requestId: "req_123",
        rateLimit: {
          "limit-requests": "200",
          "remaining-requests": "0",
          "reset-requests": "6m0s",
          "limit-tokens": "40000",
          "remaining-tokens": "39488",
          "reset-tokens": "768ms",
        },
      },
    );
  assert.doesNotMatch(JSON.stringify(failures), /Alice|1988|Rate limit/);
});

test("incomplete responses and connection failures are reported by kind", async () => {
  const failures: ModelFailure[] = [];
  await assert.rejects(callers(async () => incomplete(), failures)[0]());
  await assert.rejects(
    callers(async () => {
      throw new TypeError(`fetch failed for ${patientText}`);
    }, failures)[2](),
  );
  assert.deepEqual(failures, [
    {
      stage: "Identity extraction",
      error: "ModelIncompleteError",
      reason: "max_output_tokens",
    },
    { stage: "Refill interpretation", error: "APIConnectionError" },
  ]);
});

test("a failing listener never replaces the original model failure", async () => {
  const original = new Error("original");
  await assert.rejects(
    reportingFailures(
      "Stage",
      () => {
        throw new Error("listener");
      },
      async () => {
        throw original;
      },
    ),
    (error) => error === original,
  );
});

test("the failure logger writes one model_failed JSON line", () => {
  const lines: string[] = [];
  createModelFailureLogger({ model: "test-model" }, (line) => lines.push(line))(
    {
      stage: "Refill interpretation",
      error: "RateLimitError",
      status: 429,
      code: "rate_limit_exceeded",
    },
  );
  assert.equal(lines.length, 1);
  assert.deepEqual(
    { ...JSON.parse(lines[0]), timestamp: undefined },
    {
      timestamp: undefined,
      event: "model_failed",
      model: "test-model",
      stage: "Refill interpretation",
      error: "RateLimitError",
      status: 429,
      code: "rate_limit_exceeded",
    },
  );
});
