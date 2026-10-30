import type {
  MedicationChoice,
  PharmacyChoice,
} from "../domain/conversation.js";
import type {
  Eligibility,
  IneligibilityReason,
} from "../domain/refill-eligibility.js";

// Fixed wording for every reply that states a clinical decision, a write, or a
// handoff. Each sentence claims only what the application actually did.

const careTeamHandoff =
  "I'm referring this request to your care team, and I'll stop here so they can follow up.";

function numbered(options: readonly string[]) {
  return options.map((option, index) => `${index + 1}. ${option}`).join("\n");
}

function describePharmacy({ name, address }: PharmacyChoice) {
  return address ? `${name} (${address})` : name;
}

export function chooseMedication(
  options: readonly MedicationChoice[],
  notOnRecord?: string,
) {
  const prefix = notOnRecord
    ? `I don't see ${notOnRecord} on your record, so I can't refill it here. If you think it should be there, please check with your prescriber or care team. `
    : "";
  if (options.length === 1)
    return `${prefix}I see ${options[0].name} on your record. Would you like to refill it?`;
  return `${prefix}Which prescription would you like to refill?\n${numbered(options.map(({ name }) => name))}`;
}

export function confirmRefill(
  medication: MedicationChoice,
  pharmacy: PharmacyChoice,
  current: PharmacyChoice | null,
) {
  if (pharmacy.pharmacyId === current?.pharmacyId)
    return `Your ${medication.name} refill can go to your current pharmacy, ${describePharmacy(pharmacy)}. Reply yes to submit it there, or tell me if you'd like a different pharmacy.`;
  return `I found ${describePharmacy(pharmacy)}. Should I make it your pharmacy and submit your ${medication.name} refill there? Reply yes to confirm, or tell me a different pharmacy.`;
}

export function askForPharmacy(hasCurrent: boolean) {
  return hasCurrent
    ? "Which pharmacy would you like to use instead? A name and street or neighborhood helps me find it."
    : "I don't have a pharmacy on file for you. Which pharmacy would you like to use? A name and street or neighborhood helps me find it.";
}

export function choosePharmacy(options: readonly PharmacyChoice[]) {
  return `I found several pharmacies. Which one would you like?\n${numbered(options.map(describePharmacy))}`;
}

export function pharmacyNotFound(searched: string) {
  return `I couldn't find a pharmacy matching "${searched}" in the directory. Could you give me another name or address?`;
}

function describeReason(
  { name }: MedicationChoice,
  reason: IneligibilityReason,
) {
  switch (reason.rule) {
    case "schedule_ii":
      return `${name} is a Schedule II controlled medication, which can't be refilled through this service. Your prescriber will need to issue a new prescription.`;
    case "no_refills":
      return `Your ${name} prescription has no refills remaining, so your prescriber will need to issue a new prescription.`;
    case "expired":
      return `Your ${name} prescription expired on ${reason.expiredOn}, so your prescriber will need to issue a new prescription.`;
    case "too_early":
      return `It's too early to refill ${name}. Controlled medications can be refilled up to two days before your current supply runs out, which is ${reason.earliestRefillDate} for this prescription.`;
    case "lab_required":
      return `${name} requires a recent ${reason.labType} lab result (within the last ${reason.withinDays} days) before it can be refilled, and I don't see a qualifying result on file. Please contact your care team about getting that test.`;
  }
}

export function ineligible(
  medication: MedicationChoice,
  eligibility: Extract<Eligibility, { eligible: false }>,
) {
  const reasons = eligibility.reasons.map((reason) =>
    describeReason(medication, reason),
  );
  const next =
    eligibility.disposition === "escalate"
      ? careTeamHandoff
      : "I haven't submitted anything. Is there another prescription I can help you with?";
  return [...reasons, next].join(" ");
}

export function submitted(
  medication: MedicationChoice,
  pharmacy: PharmacyChoice,
  pharmacyChanged: boolean,
) {
  const change = pharmacyChanged
    ? ` ${pharmacy.name} is now your pharmacy on file.`
    : "";
  return `Your ${medication.name} refill has been submitted to ${pharmacy.name}.${change} The pharmacy will process it from here.`;
}

export const alreadySubmitted = (medication: MedicationChoice) =>
  `Your ${medication.name} refill has already been submitted, so I won't send it again.`;

export const submissionInProgress = (medication: MedicationChoice) =>
  `A request for ${medication.name} is already being processed, so I won't send another one. Please check back shortly.`;

export const pharmacyUpdateFailed = (pharmacy: PharmacyChoice) =>
  `I couldn't update your pharmacy to ${pharmacy.name}, so I haven't submitted the refill. Reply yes to try again, or tell me a different pharmacy.`;

export const submissionRejected = (pharmacyChanged: boolean) =>
  `The pharmacy system did not accept this refill, so nothing was submitted.${pharmacyChanged ? " Your pharmacy on file was updated." : ""} Reply yes to try again, or contact your care team for help.`;

export const submissionUnknown = (pharmacyChanged: boolean) =>
  `I couldn't confirm whether the pharmacy system received this refill. To avoid a duplicate, I won't send it again.${pharmacyChanged ? " Your pharmacy on file may have been updated." : ""} ${careTeamHandoff}`;

export const cannotProcess = () =>
  `I'm unable to process this refill as requested. ${careTeamHandoff}`;

export const noMedications = () =>
  `I don't see any prescriptions on your record that I can refill. ${careTeamHandoff}`;

export const servicesUnavailable = () =>
  "I'm having trouble reaching the pharmacy systems right now, and nothing has been submitted. Please try again in a moment.";

export const notUnderstood = () =>
  "Sorry, I'm having trouble understanding right now, and nothing has been submitted. Could you try again?";

export const cancelled = () =>
  "Okay, I've cancelled this request. Nothing was submitted and your pharmacy was not changed.";

export const scopeRedirect = (followUp: string) =>
  `I can help with prescription refills and pharmacy changes. ${followUp}`;

export const anythingElse = () =>
  "Is there a prescription you'd like to refill?";

export const confirmationDeclined = () =>
  "No problem, I haven't submitted anything. Would you like a different pharmacy, or should I cancel this request?";

export const closing = () =>
  "Okay. Nothing else was submitted. Thanks for reaching out.";
