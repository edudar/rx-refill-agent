import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";
import { createIdentityExtractor } from "./identity-extractor.js";
import { createModelResolutionLogger } from "./openai-client.js";

const update = {
  outOfScope: false,

  firstName: "Alice",
  lastName: "Nguyen",
  dob: "1988-03-12",
  phoneLast4: "1234",
  zip: null,
};
function modelResponse(
  content: unknown,
  status = "completed",
  incompleteReason?: string,
) {
  return Response.json({
    id: "resp-test",
    object: "response",
    created_at: 0,
    model: "test-model-2026-01-01",
    status,
    incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
    output: [
      {
        type: "message",
        id: "msg-test",
        role: "assistant",
        status: "completed",
        content: [content],
      },
    ],
  });
}

test("OpenAI extraction uses strict structured output, no tools, no record data", async () => {
  let calls = 0;
  const config = loadConfig({
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "test-model",
    OPENAI_REASONING_EFFORT: "none",
  });
  const extract = createIdentityExtractor({
    ...config.openai,
    fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), "https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "test-model");
      assert.deepEqual(body.reasoning, { effort: "none" });
      assert.equal(body.store, false);
      assert.equal(body.text.format.type, "json_schema");
      assert.equal(body.text.format.strict, true);
      assert.equal(body.tools, undefined);
      assert.equal(body.max_output_tokens, 512);
      assert.deepEqual(JSON.parse(body.input), {
        knownFactors: {},
        lastPrompt: "Your name?",
        patientMessage: "Alice Nguyen",
      });
      return modelResponse({
        type: "output_text",
        text: JSON.stringify(update),
        annotations: [],
      });
    },
  });
  assert.deepEqual(
    await extract({
      text: "Alice Nguyen",
      factors: {},
      lastPrompt: "Your name?",
    }),
    update,
  );
  assert.equal(calls, 1);
});

test("OpenAI refusal and incomplete output do not produce usable identity", async () => {
  for (const [response, reason] of [
    [
      () => modelResponse({ type: "refusal", refusal: "Unable to comply" }),
      /\(no parsed output\)/,
    ],
    [
      () =>
        modelResponse(
          {
            type: "output_text",
            text: JSON.stringify(update),
            annotations: [],
          },
          "incomplete",
          "max_output_tokens",
        ),
      /\(max_output_tokens\)/,
    ],
  ] as const) {
    const extract = createIdentityExtractor({
      apiKey: "test-key",
      model: "test-model",
      reasoning: { effort: "none" },
      fetch: async () => response(),
    });
    await assert.rejects(
      extract({ text: "hello", factors: {}, lastPrompt: "" }),
      reason,
    );
  }
});

test("reasoning effort above none reserves output tokens for reasoning", async () => {
  const extract = createIdentityExtractor({
    apiKey: "test-key",
    model: "test-model",
    reasoning: { effort: "low" },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.reasoning, { effort: "low" });
      assert.ok(body.max_output_tokens > 512);
      return modelResponse({
        type: "output_text",
        text: JSON.stringify(update),
        annotations: [],
      });
    },
  });
  assert.deepEqual(
    await extract({ text: "Alice Nguyen", factors: {}, lastPrompt: "" }),
    update,
  );
});

test("reports the resolved model snapshot once per distinct snapshot", async () => {
  const lines: string[] = [];
  const extract = createIdentityExtractor({
    apiKey: "test-key",
    model: "test-model",
    reasoning: { effort: "none" },
    onModelResolved: createModelResolutionLogger(
      { model: "test-model", reasoning: { effort: "none" } },
      (line) => lines.push(line),
    ),
    fetch: async () =>
      modelResponse({
        type: "output_text",
        text: JSON.stringify(update),
        annotations: [],
      }),
  });
  const input = { text: "Alice Nguyen", factors: {}, lastPrompt: "" };
  await extract(input);
  await extract(input);
  assert.equal(lines.length, 1);
  assert.deepEqual(
    { ...JSON.parse(lines[0]), timestamp: undefined },
    {
      timestamp: undefined,
      event: "model_resolved",
      configuredModel: "test-model",
      resolvedModel: "test-model-2026-01-01",
      reasoningEffort: "none",
    },
  );
});
