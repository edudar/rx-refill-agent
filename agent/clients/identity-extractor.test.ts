import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";
import { createIdentityExtractor } from "./identity-extractor.js";

const update = {
  outOfScope: false,

  firstName: "Alice",
  lastName: "Nguyen",
  dob: "1988-03-12",
  phoneLast4: "1234",
  zip: null,
};
function modelResponse(content: unknown, status = "completed") {
  return Response.json({
    id: "resp-test",
    object: "response",
    created_at: 0,
    status,
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
  for (const response of [
    () => modelResponse({ type: "refusal", refusal: "Unable to comply" }),
    () =>
      modelResponse(
        { type: "output_text", text: JSON.stringify(update), annotations: [] },
        "incomplete",
      ),
  ]) {
    const extract = createIdentityExtractor({
      apiKey: "test-key",
      model: "test-model",
      fetch: async (_url, init) => {
        assert.equal(JSON.parse(String(init?.body)).reasoning, undefined);
        return response();
      },
    });
    await assert.rejects(
      extract({ text: "hello", factors: {}, lastPrompt: "" }),
    );
  }
});
