import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
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
    sleep: async () => {},
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
  // Extraction and interpretation retry once; generation falls back instead.
  assert.deepEqual(
    failures.map(({ stage, attempt, willRetry }) => [
      stage,
      attempt,
      willRetry,
    ]),
    [
      ["Identity extraction", 1, true],
      ["Identity extraction", 2, false],
      ["Response generation", 1, false],
      ["Refill interpretation", 1, true],
      ["Refill interpretation", 2, false],
    ],
  );
  for (const failure of failures)
    assert.deepEqual(
      {
        ...failure,
        stage: undefined,
        attempt: undefined,
        willRetry: undefined,
      },
      {
        stage: undefined,
        attempt: undefined,
        willRetry: undefined,
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
      attempt: 1,
      willRetry: false,
    },
    {
      stage: "Refill interpretation",
      error: "APIConnectionError",
      attempt: 1,
      willRetry: true,
    },
    {
      stage: "Refill interpretation",
      error: "APIConnectionError",
      attempt: 2,
      willRetry: false,
    },
  ]);
});

const okResponse = () =>
  Response.json({
    id: "resp-test",
    object: "response",
    created_at: 0,
    model: "test-model",
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg-test",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              outOfScope: false,
              urgentSafety: "none",
              clinicalQuestion: false,
              intent: "confirm",
              medicationMention: null,
              optionNumber: null,
              pharmacyName: null,
              pharmacyLocation: null,
              keepCurrentPharmacy: false,
            }),
            annotations: [],
          },
        ],
      },
    ],
  });

test("a transient failure is retried once after a short wait and can still succeed", async () => {
  const failures: ModelFailure[] = [];
  const waits: number[] = [];
  let calls = 0;
  const interpret = createRefillInterpreter({
    apiKey: "test-key",
    model: "test-model",
    reasoning: { effort: "none" },
    onModelFailure: (failure) => failures.push(failure),
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetch: async () => {
      calls++;
      if (calls === 1) throw new TypeError("socket hang up");
      return okResponse();
    },
  });
  const result = await interpret({
    text: "yes",
    question: "confirm_refill",
    lastPrompt: "",
  });
  assert.equal(result.intent, "confirm");
  assert.equal(calls, 2);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 200 && waits[0] <= 600, `jittered wait ${waits[0]}`);
  assert.deepEqual(
    failures.map(({ attempt, willRetry }) => [attempt, willRetry]),
    [[1, true]],
  );
});

test("retries honour a short Retry-After, skip long ones, and never retry permanent errors", async () => {
  const outcome = async (response: () => Response) => {
    const waits: number[] = [];
    let calls = 0;
    await assert.rejects(
      reportingFailures(
        "Stage",
        undefined,
        async () => {
          calls++;
          const res = response();
          throw OpenAI.APIError.generate(
            res.status,
            await res.json(),
            "failed",
            res.headers,
          );
        },
        { retries: 1, sleep: async (ms) => void waits.push(ms) },
      ),
    );
    return { calls, waits };
  };
  const status =
    (code: number, headers: Record<string, string> = {}) =>
    () =>
      Response.json({ error: { message: "x" } }, { status: code, headers });
  assert.deepEqual(await outcome(status(429, { "retry-after-ms": "750" })), {
    calls: 2,
    waits: [750],
  });
  assert.deepEqual(await outcome(status(429, { "retry-after": "1" })), {
    calls: 2,
    waits: [1_000],
  });
  assert.deepEqual(
    await outcome(status(429, { "retry-after": "30" })),
    { calls: 1, waits: [] },
    "a wait longer than the budget allows is not attempted",
  );
  for (const permanent of [400, 401, 404])
    assert.deepEqual(await outcome(status(permanent)), { calls: 1, waits: [] });
  assert.equal((await outcome(status(503))).calls, 2);
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
