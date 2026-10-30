import assert from "node:assert/strict";
import test from "node:test";
import * as say from "./refill-messages.js";

const medication = { medId: "m-1", name: "Lisinopril 10mg" };
const pharmacy = {
  pharmacyId: "ph-1",
  name: "Bay Pharmacy",
  address: "123 Market St",
};

// Claims that only a successful submission may make.
const submissionClaim =
  /\b(?:your |the )?(?:refill|prescription|request) (?:has been |was |is |successfully )?(?:submitted|sent|processed|refilled)\b|\b(?:i(?:'ve| have)?|we(?:'ve| have)?) (?:successfully )?(?:submitted|sent|processed) (?:your |the )?(?:refill|prescription|request)\b/i;

test("only the success message claims a refill was submitted", () => {
  assert.match(say.submitted(medication, pharmacy, true), submissionClaim);
  const others = [
    say.chooseMedication([medication], "Metoprolol"),
    say.confirmRefill(medication, pharmacy, null),
    say.confirmRefill(medication, pharmacy, pharmacy),
    say.askForPharmacy(true),
    say.choosePharmacy([pharmacy, pharmacy]),
    say.pharmacyNotFound("Moon Crater"),
    say.pharmacyUpdateFailed(pharmacy),
    say.submissionRejected(true),
    say.submissionUnknown(true),
    say.cannotProcess(),
    say.noMedications(),
    say.servicesUnavailable(),
    say.notUnderstood(),
    say.cancelled(),
    say.confirmationDeclined(),
    say.closing(),
    say.ineligible(medication, {
      eligible: false,
      disposition: "hold",
      reasons: [{ rule: "too_early", earliestRefillDate: "2026-09-17" }],
    }),
  ];
  for (const text of others) assert.doesNotMatch(text, submissionClaim, text);
});

test("failed pharmacy updates never say the pharmacy changed", () => {
  for (const text of [
    say.pharmacyUpdateFailed(pharmacy),
    say.submissionUnknown(false),
  ])
    assert.doesNotMatch(
      text,
      /pharmacy (?:has been |was |is )?(?:changed|updated|switched)|is now your pharmacy/i,
    );
});

test("declines explain every failed rule and say who must act", () => {
  const text = say.ineligible(medication, {
    eligible: false,
    disposition: "escalate",
    reasons: [
      { rule: "no_refills" },
      { rule: "expired", expiredOn: "2026-08-31" },
      { rule: "lab_required", labType: "INR", withinDays: 30 },
    ],
  });
  assert.match(text, /no refills remaining/);
  assert.match(text, /expired on 2026-08-31/);
  assert.match(text, /recent INR lab result/);
  assert.match(text, /referring this request to your care team/);
  assert.doesNotMatch(
    say.ineligible(medication, {
      eligible: false,
      disposition: "hold",
      reasons: [{ rule: "lab_required", labType: "INR", withinDays: 30 }],
    }),
    /referring/,
  );
});
