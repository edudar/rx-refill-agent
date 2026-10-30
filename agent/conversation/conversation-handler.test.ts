import assert from "node:assert/strict";
import test from "node:test";
import { createConversationHandler } from "./conversation-handler.js";
import type {
  AgentMessage,
  ConversationStep,
} from "../contracts/conversation.js";
import type { PatientRecord } from "../contracts/ehr.js";
import {
  conversationBase,
  type AuthenticatingConversation,
  type Conversation,
  type VerifiedConversation,
} from "../domain/conversation.js";

const patient: PatientRecord = {
  patientId: "p-1",
  firstName: "Alice",
  lastName: "Nguyen",
  dob: "1988-03-12",
  phone: "415-555-1234",
  zip: "94107",
};

function agent(text: string): AgentMessage {
  return { from: "agent", text };
}

function verify(
  onCall: (conversation: AuthenticatingConversation) => void = () => {},
): ConversationStep<AuthenticatingConversation> {
  return async (conversation) => {
    onCall(conversation);
    return {
      conversation: {
        ...conversationBase(conversation),
        phase: "verified",
        patient,
      },
      messages: [agent("Verified.")],
      next: "continue",
    };
  };
}

test("verification hands the same turn to the next phase, then routes later turns there", async () => {
  const turns: string[] = [];
  let stored: VerifiedConversation | undefined;
  const handleTurn = createConversationHandler({
    steps: {
      authenticating: verify(() => turns.push("authenticate")),
      verified: async (conversation, turn) => {
        stored = conversation;
        turns.push(`refill:${turn.text}:${turn.handedOff}`);
        assert.equal(conversation.patient.patientId, "p-1");
        return {
          conversation,
          messages: [agent("Please confirm the pharmacy.")],
          next: "reply",
        };
      },
    },
  });

  const first = await handleTurn("one", "identity details");
  assert.deepEqual(first, {
    messages: [agent("Verified."), agent("Please confirm the pharmacy.")],
    state: "in_progress",
  });
  await handleTurn("one", "yes");
  assert.deepEqual(turns, [
    "authenticate",
    "refill:identity details:true",
    "refill:yes:false",
  ]);
  assert.equal(stored?.lastPrompt, "Please confirm the pharmacy.");
  assert.equal("factors" in (stored ?? {}), false);
});

test("without a refill workflow the verified phase replies with a placeholder", async () => {
  const handleTurn = createConversationHandler({
    steps: { authenticating: verify() },
  });
  const reply = await handleTurn("one", "identity details");
  assert.equal(reply.state, "in_progress");
  assert.equal(reply.messages[0].text, "Verified.");
  assert.match(reply.messages[1].text, /not available yet/);
});

test("a pending refill intent survives the transition to the verified phase", async () => {
  let received: VerifiedConversation | undefined;
  const handleTurn = createConversationHandler({
    steps: {
      authenticating: async (conversation, turn) => {
        if (turn.text !== "refill my lisinopril")
          return verify()(conversation, turn);
        conversation.pendingIntent = { medicationMention: "lisinopril" };
        return {
          conversation,
          messages: [agent("Please share your identity.")],
          next: "reply",
        };
      },
      verified: async (conversation) => {
        received = conversation;
        return { conversation, messages: [agent("Done.")], next: "reply" };
      },
    },
  });
  await handleTurn("one", "refill my lisinopril");
  await handleTurn("one", "identity details");
  assert.deepEqual(received?.pendingIntent, {
    medicationMention: "lisinopril",
  });
});

test("a failed turn leaves the stored conversation unchanged", async () => {
  const seen: Conversation[] = [];
  let fail = true;
  const handleTurn = createConversationHandler({
    steps: {
      authenticating: async (conversation) => {
        seen.push(structuredClone(conversation));
        conversation.factors.zip = "94107";
        conversation.pendingIntent = { medicationMention: "lisinopril" };
        if (fail) throw new Error("simulated failure");
        return { conversation, messages: [agent("Thanks.")], next: "reply" };
      },
    },
  });
  await assert.rejects(handleTurn("one", "first"), /simulated failure/);
  fail = false;
  await handleTurn("one", "second");
  const retried = seen[1] as AuthenticatingConversation;
  assert.deepEqual(retried.factors, {});
  assert.equal(retried.pendingIntent, undefined);
  assert.deepEqual(retried.history, [{ from: "patient", text: "second" }]);
});

test("steps must change phase to continue and must produce a reply", async () => {
  const stalled = createConversationHandler({
    steps: {
      authenticating: async (conversation) => ({
        conversation,
        messages: [],
        next: "continue",
      }),
    },
  });
  await assert.rejects(stalled("one", "hello"), /without a transition/);
  const silent = createConversationHandler({
    steps: {
      authenticating: async (conversation) => ({
        conversation,
        messages: [],
        next: "reply",
      }),
    },
  });
  await assert.rejects(silent("one", "hello"), /produced no reply/);
});

test("keeps a bounded recent dialogue for response generation", async () => {
  let session: Conversation | undefined;
  const handleTurn = createConversationHandler({
    steps: {
      authenticating: async (conversation) => {
        session = conversation;
        assert.ok(conversation.history.length <= 12);
        return {
          conversation,
          messages: [agent("Please share your ZIP.")],
          next: "reply",
        };
      },
    },
  });
  for (let index = 0; index < 20; index++)
    await handleTurn("one", `message-${index}`);
  assert.equal(session?.history.length, 12);
  assert.deepEqual(session?.history.slice(-2), [
    { from: "patient", text: "message-19" },
    agent("Please share your ZIP."),
  ]);
  assert.ok(!session?.history.some((message) => message.text === "message-0"));
});

test("answers later messages with the stored follow-up, never another workflow", async () => {
  for (const outcome of ["complete", "escalated"] as const) {
    let authCalls = 0;
    let nextCalls = 0;
    const terminal = [
      agent("The refill workflow has ended."),
      agent(
        outcome === "complete"
          ? "Your request was submitted."
          : "Please contact your prescriber.",
      ),
    ];
    const handleTurn = createConversationHandler({
      steps: {
        authenticating: verify(() => authCalls++),
        verified: async (conversation, turn) => {
          if (turn.handedOff)
            return { conversation, messages: [], next: "reply" };
          nextCalls++;
          return {
            conversation: {
              ...conversationBase(conversation),
              phase: "ended",
              outcome,
              followUp: `Follow-up after ${outcome}.`,
            },
            messages: terminal,
            next: "reply",
          };
        },
      },
    });
    await handleTurn("one", "identity details");
    assert.deepEqual(await handleTurn("one", "refill request"), {
      messages: terminal,
      state: outcome,
    });
    const followUp = {
      messages: [agent(`Follow-up after ${outcome}.`)],
      state: outcome,
    };
    assert.deepEqual(await handleTurn("one", "thanks"), followUp);
    assert.deepEqual(await handleTurn("one", "repeat"), followUp);
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
    steps: {
      authenticating: async (conversation, turn) => {
        calls.push("authenticate");
        await gate;
        return verify()(conversation, turn);
      },
      verified: async (conversation, turn) => {
        calls.push(`next-workflow:${turn.handedOff}`);
        return {
          conversation,
          messages: [agent("Continuing.")],
          next: "reply",
        };
      },
    },
  });
  const first = handleTurn("one", "identity details");
  const second = handleTurn("one", "refill request");
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, [
    "authenticate",
    "next-workflow:true",
    "next-workflow:false",
  ]);
});

test("expires conversations at 24 hours from creation despite recent activity", async () => {
  let clock = 0;
  let authentications = 0;
  const handleTurn = createConversationHandler({
    now: () => clock,
    steps: { authenticating: verify(() => authentications++) },
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
    steps: { authenticating: verify(() => authentications++) },
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
    steps: {
      authenticating: async (conversation, turn) => {
        authentications++;
        await gate;
        return verify()(conversation, turn);
      },
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
