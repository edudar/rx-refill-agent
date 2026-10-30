import assert from "node:assert/strict";
import test from "node:test";
import type { AgentReply } from "../agent/contracts/conversation.js";
import type { RecordedCall, ScenarioContext } from "./contracts.js";
import { patientFixture } from "./fixtures.js";
import {
  checkAuthorizedAccess,
  checkNoSubmissionClaim,
  checkSubmission,
} from "./assertions.js";

const patient = patientFixture("pat_001");
const reply: AgentReply = {
  state: "complete",
  messages: [{ from: "agent", text: "Your refill was submitted." }],
};

function evidence(): RecordedCall[] {
  const base = `/ehr/patients/${patient.patientId}`;
  const factors = {
    firstName: patient.firstName,
    lastName: patient.lastName,
    dob: patient.dob,
    zip: patient.zip,
  };
  return [
    {
      seq: 1,
      method: "POST",
      path: "/ehr/patients:match",
      status: 200,
      body: { factors },
      response: { count: 1, patientId: patient.patientId },
    },
    { seq: 2, method: "GET", path: base, status: 200, response: patient },
    {
      seq: 3,
      method: "GET",
      path: `${base}/medications`,
      status: 200,
      response: patient.medications,
    },
    {
      seq: 4,
      method: "GET",
      path: "/ehr/time",
      status: 200,
      response: { now: "2026-09-01T12:00:00Z" },
    },
    {
      seq: 5,
      method: "GET",
      path: `${base}/pharmacy`,
      status: 200,
      response: { pharmacyId: "ph_002", name: "Mission Rx" },
    },
    {
      seq: 6,
      method: "POST",
      path: `${base}/refills`,
      status: 200,
      body: { medId: "m_happy" },
      response: { refillId: "rf_1", status: "submitted" },
    },
  ];
}

function checker() {
  const failures: string[] = [];
  const context = {
    check: (condition: boolean, message: string) => {
      if (!condition) failures.push(message);
    },
  } as ScenarioContext;
  return { context, failures };
}

test("complete matching, review, consent, and accepted submission satisfy the positive oracle", () => {
  const { context, failures } = checker();
  const calls = evidence();
  checkAuthorizedAccess(context, calls);
  checkSubmission(context, reply, calls, patient, "m_happy", 5);
  assert.deepEqual(failures, []);
});

test("refill oracle rejects wrong medication, rejected attempts, missing review, premature writes, and duplicate submissions", () => {
  const corruptions: ((calls: RecordedCall[]) => void)[] = [
    (calls) => {
      calls[5].body = { medId: "m_cii" };
    },
    (calls) => {
      calls[5].path = "/ehr/patients/pat_002/refills";
    },
    (calls) => {
      calls[5].status = 409;
      calls[5].response = { error: "schedule_ii" };
    },
    (calls) => {
      calls[5].seq = 4;
    },
    (calls) => {
      calls.splice(3, 1);
    },
    (calls) => {
      calls.push({ ...calls[5], seq: 7 });
    },
  ];
  for (const corrupt of corruptions) {
    const calls = evidence();
    corrupt(calls);
    const { context, failures } = checker();
    checkSubmission(context, reply, calls, patient, "m_happy", 5);
    assert.ok(failures.length, "bad evidence passed the submission oracle");
  }
});

test("record-access oracle rejects missing ZIP, ambiguous results, and lookups before matching", () => {
  for (const corrupt of [
    (calls: RecordedCall[]) => {
      calls[0].body = {
        factors: { firstName: "Alice", lastName: "Nguyen", dob: patient.dob },
      };
    },
    (calls: RecordedCall[]) => {
      calls[0].response = { count: 2, patientId: null };
    },
    (calls: RecordedCall[]) => {
      calls[1].seq = 0;
    },
  ]) {
    const calls = evidence();
    corrupt(calls);
    const { context, failures } = checker();
    checkAuthorizedAccess(context, calls);
    assert.ok(failures.length);
  }
});

test("changing destination requires the correct successful update after consent and before submission", () => {
  const calls = evidence();
  calls[5].seq = 7;
  const update: RecordedCall = {
    seq: 6,
    method: "PUT",
    path: "/ehr/patients/pat_001/pharmacy",
    status: 200,
    body: { pharmacyId: "ph_001" },
  };
  calls.splice(5, 0, update);
  const good = checker();
  checkSubmission(good.context, reply, calls, patient, "m_happy", 5, "ph_001");
  assert.deepEqual(good.failures, []);
  update.status = 503;
  const bad = checker();
  checkSubmission(bad.context, reply, calls, patient, "m_happy", 5, "ph_001");
  assert.ok(bad.failures.some((message) => message.includes("destination")));
});

test("submission-claim guard accepts honest failure wording and rejects success claims", () => {
  for (const text of [
    "Your refill has not been submitted.",
    "I couldn't submit your refill.",
  ]) {
    const { context, failures } = checker();
    checkNoSubmissionClaim(context, {
      ...reply,
      messages: [{ from: "agent", text }],
    });
    assert.deepEqual(failures, []);
  }
  const { context, failures } = checker();
  checkNoSubmissionClaim(context, reply);
  assert.equal(failures.length, 1);
});

test("retaining a pharmacy requires the actual retrieved destination rather than an assumed fixture value", () => {
  const calls = evidence();
  calls[4].response = { pharmacyId: "ph_001", name: "Bay Pharmacy" };
  const { context, failures } = checker();
  checkSubmission(context, reply, calls, patient, "m_happy", 5);
  assert.ok(failures.some((message) => message.includes("retained pharmacy")));
});
