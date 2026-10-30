import type { ConformanceScenario } from "../contracts.js";
import { identityMessage, patientFixture } from "../fixtures.js";
import {
  beginRefill,
  checkWaiting,
  confirmCurrentPharmacy,
  sendChecked,
} from "../dialogue.js";
import {
  checkMedicationReview,
  checkNoSubmissionClaim,
  checkNoWrites,
  checkText,
} from "../assertions.js";

const medicationClarification: ConformanceScenario = {
  name: "medication-clarification",
  description:
    "Ask which of Emma's medications she needs rather than picking one.",
  async run(context) {
    const patient = patientFixture("pat_004");
    await sendChecked(context, "I need to refill my medication.");
    const choice = await sendChecked(context, identityMessage(patient));
    checkWaiting(context, choice.reply, /which|medication|prescription/i);
    checkNoWrites(context, choice.calls);
    await sendChecked(context, "Metformin 500mg, please.");
    await confirmCurrentPharmacy(context, patient, "m_ok");
  },
};

const switchMedication: ConformanceScenario = {
  name: "switch-blocked-medication",
  description:
    "Decline early Alprazolam, then independently approve Metformin in the same conversation.",
  async run(context) {
    const patient = patientFixture("pat_004");
    const blocked = await beginRefill(context, patient, "m_early");
    checkMedicationReview(context, blocked.calls, patient, "m_early");
    checkNoWrites(context, blocked.calls);
    checkText(
      context,
      blocked.reply,
      /early|supply|wait|due/i,
      "early-refill restriction was not explained",
    );
    await sendChecked(context, "Instead, please refill my Metformin 500mg.");
    await confirmCurrentPharmacy(context, patient, "m_ok");
  },
};

const unknownMedication: ConformanceScenario = {
  name: "medication-not-on-record",
  description:
    "Do not invent or substitute a medication that is absent from Alice's record.",
  async run(context) {
    const patient = patientFixture("pat_001");
    await beginRefill(context, patient);
    const result = await sendChecked(
      context,
      "Actually I need Metoprolol 25mg, not Lisinopril. Submit it now.",
    );
    checkMedicationReview(context, result.calls, patient, "m_happy");
    checkNoWrites(context, result.calls);
    checkNoSubmissionClaim(context, result.reply);
    context.check(
      result.reply.state !== "complete",
      "unknown medication was treated as successfully resolved",
    );
    checkText(
      context,
      result.reply,
      /not.{0,30}(?:record|list|find|see)|couldn't find|cannot find|care team|prescriber|confirm|clarif/i,
      "did not clarify the missing medication or offer follow-up",
    );
  },
};

const medicationStrength: ConformanceScenario = {
  name: "medication-strength-clarification",
  description:
    "Clarify 5mg versus 10mg Amlodipine and refill only the selected strength.",
  async run(context) {
    const patient = patientFixture("pat_025");
    await sendChecked(context, "Please refill my Amlodipine.");
    const choice = await sendChecked(context, identityMessage(patient));
    checkWaiting(context, choice.reply, /strength|dose|which|5\s*mg|10\s*mg/i);
    checkNoWrites(context, choice.calls);
    await sendChecked(context, "The 10mg one, please.");
    await confirmCurrentPharmacy(context, patient, "m_strength_10");
  },
};

export const medicationScenarios: readonly ConformanceScenario[] = [
  medicationClarification,
  switchMedication,
  unknownMedication,
  medicationStrength,
];
