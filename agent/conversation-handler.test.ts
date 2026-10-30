import assert from "node:assert/strict";
import test from "node:test";
import { createConversationHandler } from "./conversation-handler.js";
import type { AgentReply } from "./contracts/conversation.js";
import type { PatientRecord } from "./contracts/ehr.js";
import type { Conversation } from "./domain/conversation.js";

const patient: PatientRecord = {
  patientId: "p-1",
  firstName: "Alice",
  lastName: "Nguyen",
  dob: "1988-03-12",
  phone: "415-555-1234",
  zip: "94107",
};

test("routes verified conversations to the next workflow on subsequent turns", async () => {
  const calls: string[] = [];
  let session: Conversation | undefined;
  const handleTurn = createConversationHandler({
    authenticate: async (conversation, text) => {
      calls.push(`authenticate:${text}`);
      conversation.patient = patient;
      session = conversation;
      return {
        messages: [{ from: "agent", text: "Verified. Which prescription?" }],
        state: "in_progress",
      };
    },
    handleAuthenticated: async (conversation, text) => {
      assert.equal(conversation, session);
      assert.equal(conversation.patient?.patientId, "p-1");
      assert.equal(conversation.lastPrompt, "Verified. Which prescription?");
      calls.push(`refill:${text}`);
      return {
        messages: [{ from: "agent", text: "Please confirm the pharmacy." }],
        state: "in_progress",
      };
    },
  });

  await handleTurn("one", "identity details");
  assert.deepEqual(calls, ["authenticate:identity details"]);
  await handleTurn("one", "lisinopril");
  assert.deepEqual(calls, [
    "authenticate:identity details",
    "refill:lisinopril",
  ]);
  assert.equal(session?.lastPrompt, "Please confirm the pharmacy.");
});

test("keeps a bounded recent dialogue for response generation", async () => {
  let session: Conversation | undefined;
  const handleTurn = createConversationHandler({
    authenticate: async (conversation) => {
      session = conversation;
      assert.ok(conversation.history.length <= 12);
      return {
        messages: [{ from: "agent", text: "Please share your ZIP." }],
        state: "in_progress",
      };
    },
  });
  for (let index = 0; index < 20; index++)
    await handleTurn("one", `message-${index}`);
  assert.equal(session?.history.length, 12);
  assert.deepEqual(session?.history.slice(-2), [
    { from: "patient", text: "message-19" },
    { from: "agent", text: "Please share your ZIP." },
  ]);
  assert.ok(!session?.history.some((message) => message.text === "message-0"));
});

test("replays completed or escalated replies without invoking another workflow", async () => {
  for (const state of ["complete", "escalated"] as const) {
    let authCalls = 0;
    let nextCalls = 0;
    const terminalReply: AgentReply = {
      messages: [
        { from: "agent", text: "The refill workflow has ended." },
        {
          from: "agent",
          text:
            state === "complete"
              ? "Your request was submitted."
              : "Please contact your prescriber.",
        },
      ],
      state,
    };
    const handleTurn = createConversationHandler({
      authenticate: async (conversation) => {
        authCalls++;
        conversation.patient = patient;
        return {
          messages: [{ from: "agent", text: "Verified." }],
          state: "in_progress",
        };
      },
      handleAuthenticated: async () => {
        nextCalls++;
        return terminalReply;
      },
    });
    await handleTurn("one", "identity details");
    assert.deepEqual(await handleTurn("one", "refill request"), terminalReply);
    assert.deepEqual(await handleTurn("one", "repeat"), terminalReply);
    assert.equal(authCalls, 1);
    assert.equal(nextCalls, 1);
  }
});

test("serializes routing across the transition from authentication to the next workflow", async () => {
  const calls: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handleTurn = createConversationHandler({
    authenticate: async (conversation) => {
      calls.push("authenticate");
      await gate;
      conversation.patient = patient;
      return {
        messages: [{ from: "agent", text: "Verified." }],
        state: "in_progress",
      };
    },
    handleAuthenticated: async () => {
      calls.push("next-workflow");
      return {
        messages: [{ from: "agent", text: "Continuing." }],
        state: "in_progress",
      };
    },
  });
  const first = handleTurn("one", "identity details");
  const second = handleTurn("one", "refill request");
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["authenticate", "next-workflow"]);
});

test("expires conversations at 24 hours from creation despite recent activity", async () => {
  let clock = 0;
  let authentications = 0;
  const handleTurn = createConversationHandler({
    now: () => clock,
    authenticate: async (conversation) => {
      authentications++;
      conversation.patient = patient;
      return {
        messages: [{ from: "agent", text: "Verified." }],
        state: "in_progress",
      };
    },
  });
  await handleTurn("one", "identity details");
  clock = 24 * 60 * 60 * 1_000 - 1;
  await handleTurn("one", "still here");
  assert.equal(authentications, 1);
  clock++;
  await handleTurn("one", "one day later");
  assert.equal(authentications, 2);
});

test("at capacity evicts the least recently used idle conversation", async () => {
  let clock = 0;
  let authentications = 0;
  const handleTurn = createConversationHandler({
    now: () => clock,
    authenticate: async (conversation) => {
      authentications++;
      conversation.patient = patient;
      return {
        messages: [{ from: "agent", text: "Verified." }],
        state: "in_progress",
      };
    },
  });
  for (let index = 0; index < 100; index++) {
    clock++;
    await handleTurn(`session-${index}`, "identity details");
  }
  clock++;
  await handleTurn("session-0", "keep this conversation active");
  assert.equal(authentications, 100, "100 stored conversations must fit");
  clock++;
  await handleTurn("session-100", "new conversation");
  assert.equal(authentications, 101);
  await handleTurn("session-0", "still retained");
  assert.equal(authentications, 101);
  await handleTurn("session-1", "evicted conversation");
  assert.equal(authentications, 102, "evicted identity must be verified again");
});

test("does not evict in-flight state when all 100 conversations are busy", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let authentications = 0;
  const handleTurn = createConversationHandler({
    authenticate: async (conversation) => {
      authentications++;
      await gate;
      conversation.patient = patient;
      return {
        messages: [{ from: "agent", text: "Verified." }],
        state: "in_progress",
      };
    },
  });
  const active = Array.from({ length: 100 }, (_, index) =>
    handleTurn(`busy-${index}`, "identity details"),
  );
  try {
    await assert.rejects(
      handleTurn("overflow", "new conversation"),
      /capacity reached/,
    );
    assert.equal(authentications, 100);
  } finally {
    release();
    await Promise.all(active);
  }
  await handleTurn("busy-0", "still verified");
  assert.equal(authentications, 100);
  await handleTurn("overflow", "retry now that capacity is available");
  assert.equal(authentications, 101);
});
