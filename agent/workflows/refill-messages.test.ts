import assert from "node:assert/strict";
import test from "node:test";
import type { Eligibility } from "../domain/refill-eligibility.js";
import * as say from "./refill-messages.js";

const medication = { medId: "m-1", name: "Lisinopril 10mg" };
const pharmacy = {
  pharmacyId: "ph-1",
  name: "Bay Pharmacy",
  address: "123 Market St",
};
const current = { pharmacyId: "ph-2", name: "Mission Rx" };
type Decline = Extract<Eligibility, { eligible: false }>;
const labHold: Decline = {
  eligible: false,
  disposition: "hold",
  reasons: [
    {
      rule: "lab_required",
      labType: "INR",
      withinDays: 30,
      problem: "missing",
    },
  ],
};

// Claims that only a successful submission may make.
const submissionClaim =
  /\b(?:your |the )?(?:refill|prescription|request) (?:has been |was |is |successfully )?(?:submitted|sent|processed|refilled)\b|\b(?:i(?:'ve| have)?|we(?:'ve| have)?) (?:successfully )?(?:submitted|sent|processed) (?:your |the )?(?:refill|prescription|request)\b/i;

test("only success messages claim a refill was submitted", () => {
  assert.match(say.submitted(medication, pharmacy, true), submissionClaim);
  assert.match(say.after.submitted(medication, pharmacy), submissionClaim);
  const others = [
    say.chooseMedication([medication], "Metoprolol"),
    say.confirmRefill(medication, pharmacy, null),
    say.confirmRefill(medication, pharmacy, pharmacy),
    say.askForPharmacy(true),
    say.choosePharmacy([pharmacy, current]),
    say.pharmacyNotFound("Moon Crater"),
    say.offerCurrentPharmacy(current),
    say.pharmacyUpdateFailed(pharmacy, current),
    say.submissionRejected(true),
    say.submissionUnknown(pharmacy, true),
    say.cannotProcess(),
    say.cannotContinue("failure"),
    say.cannotContinue("unanswered"),
    say.noMedications(),
    say.servicesUnavailable(),
    say.notUnderstood(),
    say.cancelled(),
    say.confirmationDeclined(),
    say.closing(),
    say.heldReferred(medication),
    say.after.uncertain(pharmacy),
    say.after.referred(true),
    say.after.cancelled(),
    say.after.closed(),
    say.ineligible(medication, labHold),
  ];
  for (const text of others) assert.doesNotMatch(text, submissionClaim, text);
});

test("failed pharmacy updates never say the pharmacy changed, and offer the current one", () => {
  const failed = say.pharmacyUpdateFailed(pharmacy, current);
  assert.match(
    failed,
    /say "keep Mission Rx" to send it to your current pharmacy/,
  );
  for (const text of [failed, say.submissionUnknown(pharmacy, false)])
    assert.doesNotMatch(
      text,
      /pharmacy (?:has been |was |is )?(?:changed|updated|switched)|is now your pharmacy/i,
    );
});

test("reasons that all need a new prescription are stated once, with readable dates", () => {
  const text = say.ineligible(medication, {
    eligible: false,
    disposition: "escalate",
    reasons: [
      { rule: "schedule_ii" },
      { rule: "no_refills" },
      { rule: "expired", expiredOn: "2026-08-02" },
    ],
  });
  assert.match(
    text,
    /^Lisinopril 10mg can't be refilled here: it's a Schedule II controlled medication, which can't be refilled through this service, it has no refills left, and the prescription expired on August 2, 2026\. Your prescriber will need to send a new prescription\./,
  );
  assert.equal(text.match(/new prescription/g)?.length, 1);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/);
  assert.match(text, /referred this request to your care team/);
});

test("too-early declines give both the supply end and the first refill day", () => {
  const text = say.ineligible(medication, {
    eligible: false,
    disposition: "hold",
    reasons: [
      {
        rule: "too_early",
        earliestRefillDate: "2026-09-25",
        supplyEndsOn: "2026-09-27",
      },
    ],
  });
  assert.match(
    text,
    /supply runs out on September 27, 2026.*earliest you can refill it is September 25, 2026/,
  );
});

test("lab declines say what is wrong with the result on file", () => {
  const lab = (
    reason: Extract<Decline["reasons"][number], { rule: "lab_required" }>,
  ) =>
    say.ineligible(medication, {
      eligible: false,
      disposition: "hold",
      reasons: [reason],
    });
  const base = {
    rule: "lab_required" as const,
    labType: "INR",
    withinDays: 30,
  };
  assert.match(
    lab({ ...base, problem: "missing" }),
    /needs a recent INR lab test \(one from the last 30 days\).*I don't see one on file/,
  );
  assert.match(
    lab({ ...base, problem: "too_old", latestTakenOn: "2026-06-01" }),
    /most recent INR result on file is from June 1, 2026/,
  );
  assert.match(
    lab({ ...base, problem: "future_dated", latestTakenOn: "2026-09-03" }),
    /dated September 3, 2026, which is after today, so the record may need to be corrected/,
  );
});

test("holds offer other prescriptions, and otherwise refer to the care team", () => {
  const offered = say.ineligible(medication, labHold, [
    { medId: "m-2", name: "Metformin 500mg" },
  ]);
  assert.match(offered, /another prescription instead\?\n1\. Metformin 500mg/);
  assert.doesNotMatch(offered, /referred/);
  assert.match(
    say.ineligible(medication, labHold),
    /haven't submitted it\. I've referred this request to your care team for review\. If it's urgent, please contact your prescriber's office directly\./,
    "a hold with nothing else to offer is referred, never simply rejected",
  );
});

test("follow-ups after an ending explain what happened and what to do", () => {
  assert.match(
    say.after.submitted(medication, current),
    /submitted to Mission Rx once.*nothing else you need to do/,
  );
  assert.match(
    say.after.referred(true),
    /If your doctor has approved it, they'll need to send a new prescription/,
  );
  assert.doesNotMatch(say.after.referred(false), /new prescription/);
  assert.match(say.after.uncertain(current), /call Mission Rx/);
});
