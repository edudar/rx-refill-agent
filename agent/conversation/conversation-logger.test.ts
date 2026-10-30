import assert from "node:assert/strict";
import test from "node:test";
import { createConversationHandler } from "./conversation-handler.js";
import { createConsoleConversationLogger } from "./conversation-logger.js";
import type { AgentReply } from "../contracts/conversation.js";
import type { ConversationLogEvent } from "../contracts/logging.js";

const reply: AgentReply = {
  messages: [
    { from: "agent", text: "Please share your full name." },
    { from: "agent", text: "And your date of birth." },
  ],
  state: "in_progress",
};

test("logs patient text and every agent reply with correlated IDs and timing", async () => {
  const lines: string[] = [];
  let clock = 0;
  const handleTurn = createConversationHandler({
    logger: createConsoleConversationLogger((line) => lines.push(line)),
    now: () => clock,
    authenticate: async () => {
      clock += 25;
      return reply;
    },
  });
  const text = "I need my rx\n\u001b[31mplease";
  assert.deepEqual(await handleTurn("one", text), reply);
  const events = lines.map((line) => JSON.parse(line));
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "patient_message");
  assert.equal(events[0].text, text);
  assert.equal(events[0].conversationId, "one");
  assert.equal(events[0].timestamp, "1970-01-01T00:00:00.000Z");
  assert.ok(events[0].turnId);
  assert.equal(events[1].turnId, events[0].turnId);
  assert.equal(events[1].conversationId, "one");
  assert.equal(events[1].event, "agent_reply");
  assert.equal(events[1].durationMs, 25);
  assert.deepEqual(events[1].reply, reply);
  assert.ok(
    lines.every((line) => !line.includes("\n") && !line.includes("\u001b")),
  );
});

test("logs failed turns without leaking exception details or swallowing the error", async () => {
  const events: ConversationLogEvent[] = [];
  const failure = new Error("private upstream response");
  const handleTurn = createConversationHandler({
    logger: (event) => events.push(event),
    authenticate: async () => {
      throw failure;
    },
  });
  await assert.rejects(
    handleTurn("one", "hello"),
    (error) => error === failure,
  );
  assert.deepEqual(
    events.map((event) => event.event),
    ["patient_message", "turn_error"],
  );
  assert.equal(events[0].turnId, events[1].turnId);
  assert.doesNotMatch(JSON.stringify(events), /private upstream response/);
});

test("a failing logger does not prevent the workflow from returning its reply", async () => {
  const handleTurn = createConversationHandler({
    logger: () => {
      throw new Error("logging unavailable");
    },
    authenticate: async () => reply,
  });
  assert.deepEqual(await handleTurn("one", "hello"), reply);
});
