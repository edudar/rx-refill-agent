import assert from "node:assert/strict";
import test from "node:test";
import { createConversationHandler } from "../conversation/conversation-handler.js";
import type { EhrClient, LabResult, Medication } from "../contracts/ehr.js";
import type { PharmacyListing } from "../contracts/pharmacy.js";
import type {
  RefillInterpretationInput,
  RefillUnderstanding,
} from "../contracts/refill-interpretation.js";
import { ServiceRequestError } from "../contracts/service-errors.js";
import { conversationBase } from "../domain/conversation.js";
import { createRefillFlow } from "./refill.js";
import { createRefillGate } from "./refill-gate.js";

const medication = (overrides: Partial<Medication>): Medication => ({
  medId: "m_lisinopril",
  name: "Lisinopril 10mg",
  isControlled: false,
  schedule: null,
  lastFilledDate: "2026-08-25",
  daysSupply: 30,
  refillsRemaining: 2,
  rxExpirationDate: "2027-01-01",
  requiresRecentLab: null,
  ...overrides,
});
const lisinopril = medication({});
const metformin = medication({ medId: "m_metformin", name: "Metformin 500mg" });
const alprazolam = medication({
  medId: "m_alprazolam",
  name: "Alprazolam 0.5mg",
  isControlled: true,
  schedule: "CIV",
  lastFilledDate: "2026-08-20",
});
const directory: PharmacyListing[] = [
  {
    pharmacyId: "ph_001",
    name: "Bay Pharmacy",
    address: "123 Market St, San Francisco, CA",
  },
  {
    pharmacyId: "ph_002",
    name: "Mission Rx",
    address: "456 Valencia St, San Francisco, CA",
  },
  {
    pharmacyId: "ph_003",
    name: "Sunset Drugs",
    address: "789 Irving St, San Francisco, CA",
  },
];

const understood: RefillUnderstanding = {
  outOfScope: false,
  intent: "other",
  medicationMention: null,
  optionNumber: null,
  pharmacyName: null,
  pharmacyLocation: null,
  keepCurrentPharmacy: false,
};

// Authentication is stubbed: a message starting "intent:" records a refill
// intent, and "identity" verifies and hands the turn to the refill workflow.
function fixture(
  options: {
    medications?: Medication[];
    labs?: LabResult[];
    pharmacyId?: string | null;
    understanding?: Record<string, Partial<RefillUnderstanding>>;
  } = {},
) {
  const calls: string[] = [];
  const interpretations: RefillInterpretationInput[] = [];
  const fail: Partial<Record<keyof EhrClient | "search", ServiceRequestError>> =
    {};
  const record = {
    medications: options.medications ?? [lisinopril],
    pharmacyId:
      options.pharmacyId === undefined ? "ph_002" : options.pharmacyId,
  };
  const call = async <T>(name: keyof EhrClient | "search", run: () => T) => {
    calls.push(name);
    if (fail[name]) throw fail[name];
    return run();
  };
  const ehr: EhrClient = {
    match: () => assert.fail("refill workflow must not match patients"),
    getPatient: () => assert.fail("refill workflow must not read demographics"),
    getTime: () => call("getTime", () => "2026-09-01T12:00:00Z"),
    getMedications: () => call("getMedications", () => record.medications),
    getLabs: () => call("getLabs", () => options.labs ?? []),
    getPharmacy: () =>
      call("getPharmacy", () => {
        const pharmacy = directory.find(
          ({ pharmacyId }) => pharmacyId === record.pharmacyId,
        );
        return pharmacy
          ? { pharmacyId: pharmacy.pharmacyId, name: pharmacy.name }
          : null;
      }),
    setPharmacy: (_patientId, pharmacyId) =>
      call("setPharmacy", () => {
        record.pharmacyId = pharmacyId;
      }),
    submitRefill: (_patientId, medId) =>
      call("submitRefill", () => ({
        refillId: `rf_${medId}`,
        status: "submitted" as const,
      })),
  };
  const handleTurn = createConversationHandler({
    steps: {
      authenticating: async (conversation, { text }) => {
        if (text.startsWith("intent:"))
          return {
            conversation: {
              ...conversation,
              pendingIntent: { medicationMention: text.slice(7) },
            },
            messages: [{ from: "agent", text: "Please verify your identity." }],
            next: "reply",
          };
        return {
          conversation: {
            ...conversationBase(conversation),
            phase: "verified",
            patient: {
              patientId: "pat_1",
              firstName: "Alice",
              lastName: "Nguyen",
              dob: "1988-03-12",
              phone: "415-555-1234",
              zip: "94107",
            },
          },
          messages: [
            { from: "agent", text: "Thanks, your identity is verified." },
          ],
          next: "continue",
        };
      },
      verified: createRefillFlow({
        ehr,
        pharmacies: {
          search: (query) =>
            call("search", () =>
              directory.filter(({ name, address }) =>
                `${name} ${address}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              ),
            ),
        },
        interpret: async (input) => {
          interpretations.push(input);
          const scripted = options.understanding?.[input.text];
          if (!scripted) throw new Error("unscripted message");
          return { ...understood, ...scripted };
        },
        gate: createRefillGate({ ehr }),
      }),
    },
  });
  const send = async (text: string) => {
    const reply = await handleTurn("conversation", text);
    return {
      ...reply,
      text: reply.messages.map((message) => message.text).join("\n"),
    };
  };
  const writes = () =>
    calls.filter((name) => name === "setPharmacy" || name === "submitRefill");
  return { send, calls, writes, fail, record, interpretations };
}

test("a refill named before verification is reviewed and confirmed in the verifying turn", async () => {
  const f = fixture({
    understanding: {
      "Yes, keep my pharmacy.": {
        intent: "confirm",
        keepCurrentPharmacy: true,
      },
    },
  });
  await f.send("intent:Lisinopril");
  const offer = await f.send("identity");
  assert.equal(offer.messages[0].text, "Thanks, your identity is verified.");
  assert.match(
    offer.text,
    /Lisinopril 10mg refill can go to your current pharmacy, Mission Rx/,
  );
  assert.equal(offer.state, "in_progress");
  assert.deepEqual(f.calls, ["getMedications", "getTime", "getPharmacy"]);
  assert.equal(
    f.interpretations.length,
    0,
    "the identity message is not interpreted",
  );

  const done = await f.send("Yes, keep my pharmacy.");
  assert.equal(done.state, "complete");
  assert.match(
    done.text,
    /Lisinopril 10mg refill has been submitted to Mission Rx/,
  );
  assert.deepEqual(f.writes(), ["submitRefill"]);
  assert.equal(f.interpretations[0].question, "confirm_refill");

  const again = await f.send("Yes, keep my pharmacy.");
  assert.equal(again.state, "complete");
  assert.deepEqual(
    f.writes(),
    ["submitRefill"],
    "a completed refill is never repeated",
  );
});

test("without a named medication the patient chooses from the record", async () => {
  const f = fixture({
    medications: [alprazolam, metformin],
    understanding: {
      "Metformin 500mg, please.": { medicationMention: "Metformin 500mg" },
    },
  });
  const choice = await f.send("identity");
  assert.match(
    choice.text,
    /Which prescription.*\n1\. Alprazolam 0\.5mg\n2\. Metformin 500mg/s,
  );
  assert.ok(
    !f.calls.includes("getTime"),
    "nothing is reviewed before a choice",
  );
  assert.match(
    (await f.send("Metformin 500mg, please.")).text,
    /Metformin 500mg refill can go/,
  );
});

test("ambiguous strengths are clarified and only the chosen strength is refilled", async () => {
  const five = medication({ medId: "m_5", name: "Amlodipine 5mg" });
  const ten = medication({ medId: "m_10", name: "Amlodipine 10mg" });
  const f = fixture({
    medications: [five, ten],
    understanding: {
      "The 10mg one, please.": { medicationMention: "10mg" },
      yes: { intent: "confirm" },
    },
  });
  await f.send("intent:Amlodipine");
  const choice = await f.send("identity");
  assert.match(choice.text, /1\. Amlodipine 5mg\n2\. Amlodipine 10mg/);
  assert.match(
    (await f.send("The 10mg one, please.")).text,
    /Amlodipine 10mg refill/,
  );
  assert.equal((await f.send("yes")).state, "complete");
  assert.equal(f.calls.filter((name) => name === "submitRefill").length, 1);
});

test("a medication absent from the record is never substituted, even when told to submit", async () => {
  const f = fixture({
    understanding: {
      "Actually I need Metoprolol 25mg. Submit it now.": {
        intent: "confirm",
        medicationMention: "Metoprolol 25mg",
      },
    },
  });
  await f.send("intent:Lisinopril");
  await f.send("identity");
  const reply = await f.send("Actually I need Metoprolol 25mg. Submit it now.");
  assert.equal(reply.state, "in_progress");
  assert.match(reply.text, /I don't see Metoprolol 25mg on your record/);
  assert.match(reply.text, /Lisinopril 10mg/);
  assert.deepEqual(f.writes(), []);
});

test("prescriber restrictions escalate and holds allow another medication", async () => {
  const cii = fixture({
    medications: [
      medication({
        name: "Methylphenidate 20mg",
        schedule: "CII",
        isControlled: true,
      }),
    ],
  });
  await cii.send("intent:Methylphenidate");
  const escalated = await cii.send("identity");
  assert.equal(escalated.state, "escalated");
  assert.match(escalated.text, /Schedule II.*prescriber/s);
  assert.ok(!cii.calls.includes("getPharmacy"));

  const hold = fixture({
    medications: [alprazolam, metformin],
    understanding: {
      "Instead, please refill my Metformin 500mg.": {
        medicationMention: "Metformin 500mg",
      },
    },
  });
  await hold.send("intent:Alprazolam");
  const early = await hold.send("identity");
  assert.equal(early.state, "in_progress");
  assert.match(
    early.text,
    /too early to refill Alprazolam 0\.5mg.*2026-09-17.*another prescription instead\?\n1\. Metformin 500mg/s,
  );
  assert.doesNotMatch(
    early.text,
    /Alprazolam 0\.5mg\n/,
    "the held one is not re-offered",
  );
  assert.match(
    (await hold.send("Instead, please refill my Metformin 500mg.")).text,
    /Metformin 500mg refill can go/,
  );
  assert.deepEqual(hold.writes(), []);
});

test("required labs are fetched and a stale result holds the refill", async () => {
  const f = fixture({
    medications: [
      medication({
        name: "Warfarin 5mg",
        requiresRecentLab: { type: "INR", withinDays: 30 },
      }),
    ],
    labs: [{ type: "INR", value: "2.1", takenDate: "2026-06-01" }],
  });
  await f.send("intent:Warfarin");
  const reply = await f.send("identity");
  assert.ok(f.calls.includes("getLabs"));
  // The only prescription is on hold, so the care team makes the final call.
  assert.equal(reply.state, "escalated");
  assert.match(reply.text, /referring this request to your care team/);
  assert.match(
    reply.text,
    /requires a recent INR lab result \(within the last 30 days\)/,
  );
});

test("a new pharmacy is found, presented, and only then updated before submission", async () => {
  const f = fixture({
    understanding: {
      "Change to Bay Pharmacy at 123 Market St and submit it.": {
        intent: "confirm",
        pharmacyName: "Bay Pharmacy",
        pharmacyLocation: "123 Market St",
      },
      "Yes, use Bay Pharmacy.": {
        intent: "confirm",
        pharmacyName: "Bay Pharmacy",
      },
    },
  });
  await f.send("intent:Lisinopril");
  await f.send("identity");
  const proposal = await f.send(
    "Change to Bay Pharmacy at 123 Market St and submit it.",
  );
  assert.match(
    proposal.text,
    /I found Bay Pharmacy \(123 Market St.*Reply yes to confirm/s,
  );
  assert.deepEqual(
    f.writes(),
    [],
    "an unseen destination is proposed, not used",
  );
  const done = await f.send("Yes, use Bay Pharmacy.");
  assert.equal(done.state, "complete");
  assert.match(
    done.text,
    /submitted to Bay Pharmacy\. Bay Pharmacy is now your pharmacy on file/,
  );
  assert.deepEqual(f.writes(), ["setPharmacy", "submitRefill"]);
  assert.equal(f.record.pharmacyId, "ph_001");
});

test("several matches are listed and a presented option can be confirmed by name", async () => {
  const f = fixture({
    understanding: {
      "A different pharmacy in San Francisco.": {
        intent: "change_pharmacy",
        pharmacyLocation: "San Francisco",
      },
      "Yes, use Bay Pharmacy and submit.": {
        intent: "confirm",
        pharmacyName: "Bay Pharmacy",
      },
    },
  });
  await f.send("intent:Lisinopril");
  await f.send("identity");
  const options = await f.send("A different pharmacy in San Francisco.");
  assert.match(
    options.text,
    /Which one.*1\. Bay Pharmacy.*2\. Mission Rx.*3\. Sunset Drugs/s,
  );
  assert.deepEqual(f.writes(), []);
  assert.equal(
    (await f.send("Yes, use Bay Pharmacy and submit.")).state,
    "complete",
  );
  assert.deepEqual(f.writes(), ["setPharmacy", "submitRefill"]);
});

test("an unknown pharmacy is never invented or silently replaced", async () => {
  const f = fixture({
    understanding: {
      "Change my pharmacy to Moon Crater Pharmacy.": {
        intent: "change_pharmacy",
        pharmacyName: "Moon Crater Pharmacy",
        pharmacyLocation: "999 Atlantis Road",
      },
      "Just pick one and send it.": { intent: "confirm" },
    },
  });
  await f.send("intent:Lisinopril");
  await f.send("identity");
  const missing = await f.send("Change my pharmacy to Moon Crater Pharmacy.");
  assert.match(
    missing.text,
    /couldn't find a pharmacy matching "Moon Crater Pharmacy"/,
  );
  const ignored = await f.send("Just pick one and send it.");
  assert.equal(ignored.state, "in_progress");
  assert.match(ignored.text, /Which pharmacy would you like/);
  assert.deepEqual(f.writes(), []);
});

test("withdrawing an unconfirmed switch keeps the current pharmacy without an update", async () => {
  const f = fixture({
    understanding: {
      "Switch to Bay Pharmacy.": {
        intent: "change_pharmacy",
        pharmacyName: "Bay Pharmacy",
      },
      "Don't change it. Keep Mission Rx and submit.": {
        intent: "confirm",
        pharmacyName: "Mission Rx",
        keepCurrentPharmacy: true,
      },
    },
  });
  await f.send("intent:Lisinopril");
  await f.send("identity");
  await f.send("Switch to Bay Pharmacy.");
  const done = await f.send("Don't change it. Keep Mission Rx and submit.");
  assert.match(done.text, /submitted to Mission Rx/);
  assert.deepEqual(f.writes(), ["submitRefill"]);
});

test("a patient without a pharmacy on file chooses one before anything is submitted", async () => {
  const f = fixture({
    pharmacyId: null,
    understanding: {
      "Bay Pharmacy, please.": {
        intent: "change_pharmacy",
        pharmacyName: "Bay Pharmacy",
      },
      yes: { intent: "confirm" },
    },
  });
  await f.send("intent:Lisinopril");
  assert.match(
    (await f.send("identity")).text,
    /don't have a pharmacy on file/,
  );
  assert.match(
    (await f.send("Bay Pharmacy, please.")).text,
    /I found Bay Pharmacy/,
  );
  assert.equal((await f.send("yes")).state, "complete");
  assert.deepEqual(f.writes(), ["setPharmacy", "submitRefill"]);
});

test("cancellation completes without writes and unrelated requests are redirected", async () => {
  const f = fixture({
    understanding: {
      "Write me some code.": { outOfScope: true, intent: "confirm" },
      "Never mind, cancel.": { intent: "cancel" },
    },
  });
  await f.send("intent:Lisinopril");
  await f.send("identity");
  const redirect = await f.send("Write me some code.");
  assert.match(
    redirect.text,
    /^I can help with prescription refills.*Reply yes to submit/s,
  );
  const cancelled = await f.send("Never mind, cancel.");
  assert.equal(cancelled.state, "complete");
  assert.match(cancelled.text, /cancelled.*Nothing was submitted/s);
  assert.deepEqual(f.writes(), []);
});

test("outages are reported honestly and an uncertain submission is never repeated", async () => {
  const reads = fixture({ understanding: { yes: { intent: "confirm" } } });
  reads.fail.getMedications = new ServiceRequestError("unavailable", 503);
  await reads.send("intent:Lisinopril");
  const outage = await reads.send("identity");
  assert.equal(outage.state, "in_progress");
  assert.match(
    outage.text,
    /trouble reaching the pharmacy systems.*nothing has been submitted/s,
  );

  const pharmacy = fixture({
    understanding: {
      "Switch to Bay Pharmacy.": {
        intent: "change_pharmacy",
        pharmacyName: "Bay Pharmacy",
      },
      yes: { intent: "confirm" },
    },
  });
  pharmacy.fail.setPharmacy = new ServiceRequestError("unavailable", 503);
  await pharmacy.send("intent:Lisinopril");
  await pharmacy.send("identity");
  await pharmacy.send("Switch to Bay Pharmacy.");
  const failedSwitch = await pharmacy.send("yes");
  assert.equal(failedSwitch.state, "in_progress");
  assert.match(
    failedSwitch.text,
    /couldn't update your pharmacy to Bay Pharmacy/,
  );
  assert.ok(!pharmacy.calls.includes("submitRefill"));

  const submission = fixture({ understanding: { yes: { intent: "confirm" } } });
  submission.fail.submitRefill = new ServiceRequestError("unavailable", 503);
  await submission.send("intent:Lisinopril");
  await submission.send("identity");
  const uncertain = await submission.send("yes");
  assert.equal(uncertain.state, "escalated");
  assert.match(
    uncertain.text,
    /couldn't confirm whether.*won't send it again/s,
  );
  await submission.send("yes");
  assert.equal(
    submission.calls.filter((name) => name === "submitRefill").length,
    1,
  );
});

test("an interpretation failure changes nothing and asks the patient to try again", async () => {
  const f = fixture({ understanding: { yes: { intent: "confirm" } } });
  await f.send("intent:Lisinopril");
  await f.send("identity");
  const reply = await f.send("unscripted");
  assert.equal(reply.state, "in_progress");
  assert.match(reply.text, /trouble understanding/);
  assert.equal((await f.send("yes")).state, "complete");
});

test("declining the alternatives to a held refill refers it to the care team", async () => {
  const f = fixture({
    medications: [alprazolam, metformin],
    understanding: { "No, just that one.": { intent: "decline" } },
  });
  await f.send("intent:Alprazolam");
  await f.send("identity");
  const reply = await f.send("No, just that one.");
  assert.equal(reply.state, "escalated");
  assert.match(
    reply.text,
    /referring your Alprazolam 0\.5mg request to your care team/,
  );
  assert.deepEqual(f.writes(), []);
});

test("three turns without progress hand off instead of asking again", async () => {
  const f = fixture({
    understanding: {
      "Moon Crater Pharmacy.": {
        intent: "change_pharmacy",
        pharmacyName: "Moon Crater",
      },
      "Just pick one.": { intent: "confirm" },
      "Whatever.": { intent: "other" },
    },
  });
  await f.send("intent:Lisinopril");
  await f.send("identity");
  assert.equal((await f.send("Moon Crater Pharmacy.")).state, "in_progress");
  assert.equal((await f.send("Just pick one.")).state, "in_progress");
  const ended = await f.send("Whatever.");
  assert.equal(ended.state, "escalated");
  assert.match(
    ended.text,
    /haven't been able to complete this refill.*nothing has been submitted.*care team/s,
  );
  assert.deepEqual(f.writes(), []);
});

test("progress resets the count of turns without progress", async () => {
  const f = fixture({
    understanding: {
      "Moon Crater Pharmacy.": {
        intent: "change_pharmacy",
        pharmacyName: "Moon Crater",
      },
      "Just pick one.": { intent: "confirm" },
      "Bay Pharmacy.": {
        intent: "change_pharmacy",
        pharmacyName: "Bay Pharmacy",
      },
      "No.": { intent: "decline" },
      yes: { intent: "confirm" },
    },
  });
  await f.send("intent:Lisinopril");
  await f.send("identity");
  await f.send("Moon Crater Pharmacy.");
  await f.send("Just pick one.");
  assert.match((await f.send("Bay Pharmacy.")).text, /I found Bay Pharmacy/);
  assert.equal((await f.send("No.")).state, "in_progress");
  assert.equal((await f.send("yes")).state, "complete");
});

test("a second consecutive failure hands off rather than offering another retry", async () => {
  const f = fixture({
    understanding: {
      "Switch to Bay Pharmacy.": {
        intent: "change_pharmacy",
        pharmacyName: "Bay Pharmacy",
      },
      yes: { intent: "confirm" },
    },
  });
  f.fail.setPharmacy = new ServiceRequestError("unavailable", 503);
  await f.send("intent:Lisinopril");
  await f.send("identity");
  await f.send("Switch to Bay Pharmacy.");
  const first = await f.send("yes");
  assert.equal(first.state, "in_progress");
  assert.match(first.text, /Reply yes to try again/);
  const second = await f.send("yes");
  assert.equal(second.state, "escalated");
  assert.match(
    second.text,
    /problem with our systems.*nothing has been submitted/s,
  );
  assert.equal(f.calls.filter((name) => name === "setPharmacy").length, 2);
  assert.ok(!f.calls.includes("submitRefill"));
});

test("a record that changes before submission is referred rather than retried", async () => {
  const f = fixture({ understanding: { yes: { intent: "confirm" } } });
  await f.send("intent:Lisinopril");
  await f.send("identity");
  f.record.medications = [medication({ refillsRemaining: 0 })];
  const reply = await f.send("yes");
  assert.equal(reply.state, "escalated");
  assert.match(reply.text, /no refills remaining/);
  assert.deepEqual(f.writes(), []);
});
