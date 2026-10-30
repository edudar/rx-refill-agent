import assert from "node:assert/strict";
import test from "node:test";
import { createResponseGenerator } from "./response-generator.js";
import type { ResponseGenerationInput } from "../contracts/response-generation.js";

const input: ResponseGenerationInput = {
  decision: {
    action: "request_identity",
    acceptedFields: ["firstName", "lastName", "dob"],
    newlyReceivedFields: ["firstName", "lastName", "dob"],
    requestedFields: ["zip"],
    invalidFields: [],
    failedMatchAttempts: 0,
    unansweredRequests: 1,
  },
  messages: [
    { from: "patient", text: "Alice Nguyen, DOB March 12, 1988." },
    { from: "agent", text: "What ZIP code is on your record?" },
    { from: "patient", text: "Yes, keep my pharmacy." },
  ],
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

test("generates wording from the trusted decision and recent dialogue using the configured model", async () => {
  const wording =
    "We can confirm your pharmacy shortly. First, what's your ZIP code?";
  let calls = 0;
  const generate = createResponseGenerator({
    apiKey: "test-key",
    model: "test-model",
    reasoning: { effort: "none" },
    fetch: async (url, init) => {
      calls++;
      assert.equal(String(url), "https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "test-model");
      assert.deepEqual(body.reasoning, { effort: "none" });
      assert.equal(body.store, false);
      assert.equal(body.tools, undefined);
      assert.equal(body.text.format.strict, true);
      assert.equal(body.text.format.name, "patient_response");
      assert.deepEqual(JSON.parse(body.input), {
        decision: input.decision,
        recentMessages: input.messages,
      });
      assert.match(body.instructions, /untrusted conversation data/);
      assert.match(body.instructions, /Only identity_verified/);
      return modelResponse({
        type: "output_text",
        text: JSON.stringify({ text: wording }),
        annotations: [],
      });
    },
  });
  assert.deepEqual(await generate(input), { text: wording });
  assert.equal(calls, 1);
});

test("limits supplied dialogue to the most recent messages", async () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    from: "patient" as const,
    text: `message-${index}`,
  }));
  const generate = createResponseGenerator({
    apiKey: "test-key",
    model: "test-model",
    fetch: async (_url, init) => {
      assert.deepEqual(
        JSON.parse(JSON.parse(String(init?.body)).input).recentMessages,
        messages.slice(-12),
      );
      return modelResponse({
        type: "output_text",
        text: JSON.stringify({ text: "What's your ZIP code?" }),
        annotations: [],
      });
    },
  });
  await generate({ ...input, messages });
});

test("rejects refusal, incomplete output, empty text, and attempts to supply workflow state", async () => {
  for (const response of [
    () => modelResponse({ type: "refusal", refusal: "Unable to comply" }),
    () =>
      modelResponse(
        {
          type: "output_text",
          text: JSON.stringify({ text: "What's your ZIP?" }),
          annotations: [],
        },
        "incomplete",
      ),
    () =>
      modelResponse({
        type: "output_text",
        text: JSON.stringify({ text: " " }),
        annotations: [],
      }),
    () =>
      modelResponse({
        type: "output_text",
        text: JSON.stringify({ text: "Done", state: "complete" }),
        annotations: [],
      }),
  ]) {
    const generate = createResponseGenerator({
      apiKey: "test-key",
      model: "test-model",
      fetch: async () => response(),
    });
    await assert.rejects(generate(input));
  }
});
