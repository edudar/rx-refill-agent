import assert from "node:assert/strict";
import test from "node:test";
import { createAuthenticationFlow } from "./authentication.js";
import { createConversationHandler } from "../conversation/conversation-handler.js";

import type {
  ResponseGenerator,
  ResponseGenerationInput,
} from "../contracts/response-generation.js";
import type { EhrClient, PatientRecord } from "../contracts/ehr.js";
import type {
  ExtractionInput,
  IdentityUpdate,
} from "../contracts/identity-extraction.js";

function createFlow(
  options: Omit<
    Parameters<typeof createAuthenticationFlow>[0],
    "generateResponse"
  > & {
    generateResponse?: ResponseGenerator;
    now?: () => number;
  },
) {
  return createConversationHandler({
    authenticate: createAuthenticationFlow({
      ...options,
      generateResponse:
        options.generateResponse ??
        (async () => {
          throw new Error("Simulated renderer outage");
        }),
    }),
    now: options.now,
  });
}

const empty: IdentityUpdate = {
  outOfScope: false,

  firstName: null,
  lastName: null,
  dob: null,
  phoneLast4: null,
  zip: null,
};
const identity = {
  firstName: "Alice",
  lastName: "Nguyen",
  dob: "1988-03-12",
  zip: "94107",
};
const patient: PatientRecord = {
  patientId: "p-1",
  ...identity,
  phone: "415-555-1234",
  zip: "94107",
};

function fixture(
  updates: Record<string, Partial<IdentityUpdate>>,
  overrides: Partial<EhrClient> = {},
  generateResponse?: ResponseGenerator,
) {
  const matches: unknown[] = [];
  const reads: string[] = [];
  const extractions: ExtractionInput[] = [];
  const flow = createFlow({
    generateResponse,
    extractIdentity: async (input) => {
      extractions.push(input);
      return { ...empty, ...updates[input.text] };
    },
    ehr: {
      match: async (factors) => {
        matches.push(factors);
        return overrides.match
          ? overrides.match(factors)
          : { count: 1, patientId: patient.patientId };
      },
      getPatient: async (id) => {
        reads.push(id);
        return overrides.getPatient ? overrides.getPatient(id) : patient;
      },
    },
  });
  return { flow, matches, reads, extractions };
}

test("broad request prompts for identity without accessing EHR", async () => {
  const f = fixture({});
  const reply = await f.flow("one", "I need to refill my rx");
  assert.equal(reply.state, "in_progress");
  assert.match(
    reply.messages[0].text,
    /full name.*date of birth, and five-digit ZIP/,
  );
  assert.doesNotMatch(reply.messages[0].text, /phone|last four/);
  assert.doesNotMatch(reply.messages[0].text, /YYYY-MM-DD/);
  assert.equal(f.matches.length, 0);
  assert.equal(f.reads.length, 0);
});

test("collects partial details and requests only missing information", async () => {
  const f = fixture({
    name: { firstName: "Alice", lastName: "Nguyen" },
    birth: { dob: identity.dob },
    zip: { zip: "94107" },
  });
  const nameReply = await f.flow("one", "name");
  assert.doesNotMatch(nameReply.messages[0].text, /first name|last name/);
  assert.match(nameReply.messages[0].text, /date of birth.*ZIP/);
  await f.flow("one", "birth");
  assert.equal(f.matches.length, 0);
  const verified = await f.flow("one", "zip");
  assert.match(verified.messages[0].text, /identity is verified/);
  assert.equal(verified.state, "in_progress");
  assert.deepEqual(f.matches, [identity]);
  assert.deepEqual(f.reads, ["p-1"]);
  assert.doesNotMatch(JSON.stringify(verified), /1988|94107|415-555|p-1/);
  await f.flow("one", "next");
  assert.equal(f.matches.length, 1);
  assert.equal(f.reads.length, 1);
});

test("passes validated decisions and recent dialogue to the generator without prescribing wording", async () => {
  const inputs: ResponseGenerationInput[] = [];
  const f = fixture(
    {
      details: { firstName: "Alice", lastName: "Nguyen", dob: identity.dob },
      zip: { zip: "94107" },
    },
    {},
    async (input) => {
      inputs.push(input);
      return {
        text:
          input.decision.action === "identity_verified"
            ? "You're verified. Let's discuss the prescription."
            : "Thanks for sharing that. Which ZIP is on your record?",
      };
    },
  );
  const partial = await f.flow("one", "details");
  assert.equal(
    partial.messages[0].text,
    "Thanks for sharing that. Which ZIP is on your record?",
  );
  assert.equal(inputs[0].decision.action, "request_identity");
  assert.deepEqual(inputs[0].decision.newlyReceivedFields, [
    "firstName",
    "lastName",
    "dob",
  ]);
  assert.deepEqual(inputs[0].decision.requestedFields, ["zip"]);
  assert.deepEqual(inputs[0].messages, [{ from: "patient", text: "details" }]);
  assert.equal(f.matches.length, 0);

  await f.flow("one", "Yes, keep my pharmacy.");
  assert.equal(inputs[1].decision.unansweredRequests, 1);
  assert.deepEqual(inputs[1].decision.newlyReceivedFields, []);
  assert.deepEqual(inputs[1].decision.requestedFields, ["zip"]);
  assert.deepEqual(inputs[1].messages.slice(-2), [
    partial.messages[0],
    { from: "patient", text: "Yes, keep my pharmacy." },
  ]);
  assert.equal(f.matches.length, 0);
  await f.flow("one", "zip");
  assert.equal(inputs[2].decision.action, "identity_verified");
  assert.deepEqual(f.reads, ["p-1"]);
  assert.doesNotMatch(JSON.stringify(inputs), /415-555|p-1/);
});

test("hard scope redirects skip generation and cannot populate identity", async () => {
  let generated = false;
  const f = fixture(
    { unrelated: { ...identity, outOfScope: true } },
    {},
    async () => {
      generated = true;
      return { text: "This must not be shown." };
    },
  );
  assert.match(
    (await f.flow("one", "unrelated")).messages[0].text,
    /prescription refills/,
  );
  assert.equal(generated, false);
  assert.equal(f.matches.length, 0);
});

test("invalid generator output cannot change workflow state and falls back safely", async () => {
  const f = fixture(
    {},
    {},
    async () =>
      ({ text: "Submitted.", state: "complete" }) as unknown as {
        text: string;
      },
  );
  const reply = await f.flow("one", "hello");
  assert.equal(reply.state, "in_progress");
  assert.match(reply.messages[0].text, /full name/);
  assert.doesNotMatch(reply.messages[0].text, /Submitted/);
  assert.equal(f.matches.length, 0);
});

test("verifies name, DOB, and ZIP without requiring phone digits", async () => {
  const f = fixture({ all: identity });
  assert.match(
    (await f.flow("one", "all")).messages[0].text,
    /identity is verified/,
  );
  assert.deepEqual(f.reads, ["p-1"]);
  assert.deepEqual(f.matches, [identity]);
});

test("accepts DOB in multiple formats and sends normalized dates to the EHR", async () => {
  for (const dob of ["March 12, 1988", "12 Mar 1988", "1988/3/12"]) {
    const f = fixture({ all: { ...identity, dob } });
    assert.match(
      (await f.flow("one", "all")).messages[0].text,
      /identity is verified/,
    );
    assert.deepEqual(f.matches, [identity]);
  }
});

test("ambiguous DOB requests a written month and waits for clarification before EHR access", async () => {
  const f = fixture({
    ambiguous: { ...identity, dob: "03/12/1988" },
    clarified: { dob: "March 12, 1988" },
  });
  const reply = await f.flow("one", "ambiguous");
  assert.match(reply.messages[0].text, /month written out/);
  assert.equal(f.matches.length, 0);
  assert.equal(f.reads.length, 0);
  assert.match(
    (await f.flow("one", "clarified")).messages[0].text,
    /identity is verified/,
  );
  assert.deepEqual(f.matches, [identity]);
});

test("phone digits cannot substitute for a missing ZIP code", async () => {
  const f = fixture({
    partial: {
      firstName: "Alice",
      lastName: "Nguyen",
      dob: identity.dob,
      phoneLast4: "1234",
    },
    zip: { zip: "94107" },
  });
  const reply = await f.flow("one", "partial");
  assert.match(reply.messages[0].text, /ZIP/);
  assert.equal(f.matches.length, 0);
  assert.equal(f.reads.length, 0);
  assert.match(
    (await f.flow("one", "zip")).messages[0].text,
    /identity is verified/,
  );
  assert.deepEqual(f.matches, [{ ...identity, phoneLast4: "1234" }]);
});

test("invalid supplied optional phone digits prompt correction before matching", async () => {
  const f = fixture({
    invalid: { ...identity, phoneLast4: "123" },
    correction: { phoneLast4: "1234" },
  });
  assert.match((await f.flow("one", "invalid")).messages[0].text, /last four/);
  assert.equal(f.matches.length, 0);
  assert.match(
    (await f.flow("one", "correction")).messages[0].text,
    /identity is verified/,
  );
  assert.deepEqual(f.matches, [{ ...identity, phoneLast4: "1234" }]);
});

test("record verification checks ZIP and optional phone digits when supplied", async () => {
  for (const record of [
    { ...patient, zip: "99999" },
    { ...patient, phone: "415-555-9999" },
  ]) {
    const f = fixture(
      { all: { ...identity, phoneLast4: "1234" } },
      {
        getPatient: async () => record,
      },
    );
    assert.match(
      (await f.flow("one", "all")).messages[0].text,
      /trouble verifying/,
    );
    assert.match(
      (await f.flow("one", "retry")).messages[0].text,
      /trouble verifying/,
    );
    assert.equal(
      f.reads.length,
      2,
      "mismatched records must not establish authentication",
    );
  }
});

test("invalid dates and ZIP codes cannot trigger matching", async () => {
  const f = fixture({
    invalid: { ...identity, dob: "1988-02-30", zip: "9410" },
  });
  const reply = await f.flow("one", "invalid");
  assert.match(reply.messages[0].text, /date of birth.*ZIP/);
  assert.equal(f.matches.length, 0);
});

test("an invalid correction clears the prior field rather than using stale identity", async () => {
  const f = fixture({
    partial: { firstName: "Alice", lastName: "Nguyen", dob: identity.dob },
    correction: { dob: "03/04/1988", zip: "94107" },
  });
  await f.flow("one", "partial");
  const reply = await f.flow("one", "correction");
  assert.match(reply.messages[0].text, /date of birth/);
  assert.equal(f.matches.length, 0);
});

test("failed match permits corrections but never fetches a record early", async () => {
  const f = fixture(
    {
      wrong: { ...identity, phoneLast4: "9999" },
      correction: { phoneLast4: "1234" },
    },
    {
      match: async (factors) =>
        factors.phoneLast4 === "1234"
          ? { count: 1, patientId: "p-1" }
          : { count: 0, patientId: null },
    },
  );
  await f.flow("one", "wrong");
  assert.equal(f.reads.length, 0);
  await f.flow("one", "try again");
  assert.equal(
    f.matches.length,
    1,
    "identical failed factors must not be retried",
  );
  assert.match(
    (await f.flow("one", "correction")).messages[0].text,
    /identity is verified/,
  );
  assert.equal(f.matches.length, 2);
});

test("ambiguous match asks for optional phone digits and waits for a unique match", async () => {
  const f = fixture(
    { all: identity, phone: { phoneLast4: "1234" } },
    {
      match: async (factors) =>
        factors.phoneLast4
          ? { count: 1, patientId: "p-1" }
          : { count: 2, patientId: null },
    },
  );
  assert.match((await f.flow("one", "all")).messages[0].text, /last four/);
  assert.equal(f.reads.length, 0);
  assert.match(
    (await f.flow("one", "phone")).messages[0].text,
    /identity is verified/,
  );
});

test("three distinct failed attempts escalate and stop further work", async () => {
  const f = fixture(
    {
      first: { ...identity, phoneLast4: "1111" },
      second: { phoneLast4: "2222" },
      third: { phoneLast4: "3333" },
    },
    { match: async () => ({ count: 0, patientId: null }) },
  );
  await f.flow("one", "first");
  await f.flow("one", "second");
  assert.equal((await f.flow("one", "third")).state, "escalated");
  assert.equal((await f.flow("one", "anything")).state, "escalated");
  assert.equal(f.extractions.length, 3);
  assert.equal(f.matches.length, 3);
  assert.equal(f.reads.length, 0);
});

test("out-of-scope extraction cannot populate identity or cause EHR requests", async () => {
  const f = fixture({
    unrelated: { ...identity, outOfScope: true },
    zip: { zip: "94107" },
  });
  assert.match(
    (await f.flow("one", "unrelated")).messages[0].text,
    /prescription refills/,
  );
  const reply = await f.flow("one", "zip");
  assert.match(reply.messages[0].text, /(?:full|first) name/);
  assert.equal(f.matches.length, 0);
});

test("conversations do not share identity details", async () => {
  const f = fixture({
    partial: { firstName: "Alice", lastName: "Nguyen", dob: identity.dob },
    zip: { zip: "94107" },
  });
  await f.flow("one", "partial");
  assert.match(
    (await f.flow("two", "zip")).messages[0].text,
    /(?:full|first) name/,
  );
  assert.equal(f.matches.length, 0);
});

test("EHR outages preserve details for retry and do not authenticate", async () => {
  let available = false;
  const f = fixture(
    { all: identity },
    {
      getPatient: async () => {
        if (!available) throw new Error("secret upstream error");
        return patient;
      },
    },
  );
  const failed = await f.flow("one", "all");
  assert.match(failed.messages[0].text, /trouble verifying/);
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
  available = true;
  assert.match(
    (await f.flow("one", "retry")).messages[0].text,
    /identity is verified/,
  );
});

test("record demographics must agree with supplied identity", async () => {
  const f = fixture(
    { all: identity },
    { getPatient: async () => ({ ...patient, firstName: "Bob" }) },
  );
  assert.match(
    (await f.flow("one", "all")).messages[0].text,
    /trouble verifying/,
  );
  assert.match(
    (await f.flow("one", "retry")).messages[0].text,
    /trouble verifying/,
  );
  assert.equal(f.reads.length, 2);
});

test("same-conversation concurrent messages are processed in order", async () => {
  const f = fixture({
    partial: { firstName: "Alice", lastName: "Nguyen", dob: identity.dob },
    zip: { zip: "94107" },
  });
  const [, verified] = await Promise.all([
    f.flow("one", "partial"),
    f.flow("one", "zip"),
  ]);
  assert.match(verified.messages[0].text, /identity is verified/);
  assert.equal(f.extractions[1].factors.firstName, "Alice");
  assert.equal(f.matches.length, 1);
});

test("expired authentication requires verification again", async () => {
  let clock = 0;
  let reads = 0;
  const flow = createFlow({
    now: () => clock,
    extractIdentity: async ({ text }) => ({
      ...empty,
      ...(text === "all" ? identity : {}),
    }),
    ehr: {
      match: async () => ({ count: 1, patientId: "p-1" }),
      getPatient: async () => {
        reads++;
        return patient;
      },
    },
  });
  await flow("one", "all");
  clock += 24 * 60 * 60 * 1_000;
  assert.match(
    (await flow("one", "hello")).messages[0].text,
    /(?:full|first) name/,
  );
  assert.equal(reads, 1);
});

test("malformed model output fails closed without EHR access", async () => {
  const flow = createFlow({
    extractIdentity: async () => ({ firstName: "Alice" }) as IdentityUpdate,
    ehr: {
      match: async () => {
        assert.fail("must not call EHR");
      },
      getPatient: async () => {
        assert.fail("must not read record");
      },
    },
  });
  assert.match(
    (await flow("one", "hello")).messages[0].text,
    /trouble verifying/,
  );
});
