import assert from "node:assert/strict";
import test from "node:test";
import { createRefillInterpreter } from "./refill-interpreter.js";

const understanding = {
  urgentSafety: "none",
  clinicalQuestion: false,
  outOfScope: false,
  intent: "change_pharmacy",
  medicationMention: null,
  optionNumber: null,
  pharmacyName: "Bay Pharmacy",
  pharmacyLocation: "123 Market St",
  keepCurrentPharmacy: false,
};

function modelResponse(text: string, status = "completed") {
  return Response.json({
    id: "resp-test",
    object: "response",
    created_at: 0,
    model: "test-model-2026-01-01",
    status,
    output: [
      {
        type: "message",
        id: "msg-test",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
  });
}

test("refill interpretation sends only the message and question, with strict output and no tools", async () => {
  const interpret = createRefillInterpreter({
    apiKey: "test-key",
    model: "test-model",
    reasoning: { effort: "none" },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.store, false);
      assert.equal(body.tools, undefined);
      assert.equal(body.text.format.strict, true);
      assert.equal(body.text.format.name, "refill_understanding");
      assert.deepEqual(JSON.parse(body.input), {
        question: "confirm_refill",
        lastPrompt: "Reply yes to submit it there.",
        patientMessage: "Use Bay Pharmacy on Market instead.",
      });
      assert.match(body.instructions, /untrusted data/);
      return modelResponse(JSON.stringify(understanding));
    },
  });
  assert.deepEqual(
    await interpret({
      text: "Use Bay Pharmacy on Market instead.",
      question: "confirm_refill",
      lastPrompt: "Reply yes to submit it there.",
    }),
    understanding,
  );
});

test("incomplete or malformed interpretation is rejected", async () => {
  for (const response of [
    () => modelResponse(JSON.stringify(understanding), "incomplete"),
    () => modelResponse(JSON.stringify({ ...understanding, intent: "submit" })),
  ]) {
    const interpret = createRefillInterpreter({
      apiKey: "test-key",
      model: "test-model",
      reasoning: { effort: "none" },
      fetch: async () => response(),
    });
    await assert.rejects(
      interpret({ text: "yes", question: "confirm_refill", lastPrompt: "" }),
    );
  }
});
