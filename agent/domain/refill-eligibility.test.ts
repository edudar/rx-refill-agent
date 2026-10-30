import assert from "node:assert/strict";
import test from "node:test";
import type { LabResult, Medication } from "../contracts/ehr.js";
import { evaluateRefillEligibility } from "./refill-eligibility.js";

const now = "2026-09-01T12:00:00Z";
const medication: Medication = {
  medId: "m-1",
  name: "Lisinopril 10mg",
  isControlled: false,
  schedule: null,
  lastFilledDate: "2026-08-25",
  daysSupply: 30,
  refillsRemaining: 2,
  rxExpirationDate: "2027-01-01",
  requiresRecentLab: null,
};
const inr = { type: "INR", withinDays: 30 };
const lab = (takenDate: string, type = "INR"): LabResult => ({
  type,
  value: "2.4",
  takenDate,
});

test("refill rules decline, hold, or allow at each boundary", () => {
  const cases: [string, Partial<Medication>, LabResult[], unknown][] = [
    ["non-controlled refill well before run-out", {}, [], true],
    [
      "Schedule II",
      { schedule: "CII", isControlled: true },
      [],
      ["escalate", "schedule_ii"],
    ],
    [
      "no refills remaining",
      { refillsRemaining: 0 },
      [],
      ["escalate", "no_refills"],
    ],
    [
      "expired yesterday",
      { rxExpirationDate: "2026-08-31" },
      [],
      ["escalate", "expired"],
    ],
    ["expires today", { rxExpirationDate: "2026-09-01" }, [], true],
    // Run-out 2026-09-04; the earliest controlled refill is 2026-09-02.
    [
      "controlled three days before run-out",
      { schedule: "CIV", isControlled: true, lastFilledDate: "2026-08-05" },
      [],
      ["hold", "too_early"],
    ],
    [
      "controlled exactly two days before run-out",
      { schedule: "CIV", isControlled: true, lastFilledDate: "2026-08-04" },
      [],
      true,
    ],
    [
      "controlled after run-out",
      { schedule: "CV", isControlled: true, lastFilledDate: "2026-07-01" },
      [],
      true,
    ],
    [
      "controlled flag without schedule",
      { isControlled: true, lastFilledDate: "2026-08-05" },
      [],
      ["hold", "too_early"],
    ],
    [
      "required lab missing",
      { requiresRecentLab: inr },
      [],
      ["hold", "lab_required"],
    ],
    [
      "required lab of another type",
      { requiresRecentLab: inr },
      [lab("2026-08-30", "A1C")],
      ["hold", "lab_required"],
    ],
    [
      "required lab one day too old",
      { requiresRecentLab: inr },
      [lab("2026-08-01")],
      ["hold", "lab_required"],
    ],
    [
      "required lab exactly withinDays old",
      { requiresRecentLab: inr },
      [lab("2026-08-02")],
      true,
    ],
    [
      "required lab dated in the future",
      { requiresRecentLab: inr },
      [lab("2026-09-02")],
      ["hold", "lab_required"],
    ],
    [
      "any qualifying result among several",
      { requiresRecentLab: inr },
      [lab("2026-01-01"), lab("2026-08-20")],
      true,
    ],
    [
      "lab type differs only in case",
      { requiresRecentLab: inr },
      [lab("2026-08-20", " inr ")],
      true,
    ],
  ];
  for (const [name, overrides, labs, expected] of cases) {
    const result = evaluateRefillEligibility(
      { ...medication, ...overrides },
      labs,
      now,
    );
    const actual = result.eligible
      ? true
      : [result.disposition, ...result.reasons.map(({ rule }) => rule)];
    assert.deepEqual(actual, expected, name);
  }
});

test("declines report every failed rule, and any prescriber rule escalates", () => {
  const result = evaluateRefillEligibility(
    {
      ...medication,
      schedule: "CIII",
      isControlled: true,
      lastFilledDate: "2026-08-30",
      refillsRemaining: 0,
      requiresRecentLab: inr,
    },
    [],
    now,
  );
  assert.deepEqual(result, {
    eligible: false,
    disposition: "escalate",
    reasons: [
      { rule: "no_refills" },
      { rule: "too_early", earliestRefillDate: "2026-09-27" },
      { rule: "lab_required", labType: "INR", withinDays: 30 },
    ],
  });
});

test("rules use the UTC calendar day of the EHR clock", () => {
  const expiring = { ...medication, rxExpirationDate: "2026-09-01" };
  // 23:30 at UTC-5 is already 2026-09-02 in UTC, so the prescription has expired.
  assert.equal(
    evaluateRefillEligibility(expiring, [], "2026-09-01T23:30:00-05:00")
      .eligible,
    false,
  );
  assert.equal(
    evaluateRefillEligibility(expiring, [], "2026-09-01T23:59:59Z").eligible,
    true,
  );
});

test("invalid clocks or calendar dates fail instead of guessing", () => {
  assert.throws(
    () => evaluateRefillEligibility(medication, [], "soon"),
    /clock/,
  );
  assert.throws(
    () =>
      evaluateRefillEligibility(
        { ...medication, rxExpirationDate: "2026-02-31" },
        [],
        now,
      ),
    /calendar date/,
  );
});
