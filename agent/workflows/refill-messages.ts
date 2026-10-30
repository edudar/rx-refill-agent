import type {
  MedicationChoice,
  PharmacyChoice,
} from "../domain/conversation.js";
import type {
  Eligibility,
  IneligibilityReason,
} from "../domain/refill-eligibility.js";
import { formatDate } from "../utils/calendar-date.js";

// Fixed wording for every reply that states a clinical decision, a write, or a
// handoff. Each sentence claims only what the application actually did.

// The escalated state is the handoff; the reply adds a next step the patient can
// take themselves without promising a callback.
const careTeamHandoff =
  "I've referred this request to your care team for review. If it's urgent, please contact your prescriber's office directly.";

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

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

type PrescriberReason = Extract<
  IneligibilityReason,
  { rule: "schedule_ii" | "no_refills" | "expired" }
>;

function isPrescriberReason(
  reason: IneligibilityReason,
): reason is PrescriberReason {
  return ["schedule_ii", "no_refills", "expired"].includes(reason.rule);
}

function prescriberClause(reason: PrescriberReason) {
  switch (reason.rule) {
    case "schedule_ii":
      return "it's a Schedule II controlled medication, which can't be refilled through this service";
    case "no_refills":
      return "it has no refills left";
    case "expired":
      return `the prescription expired on ${formatDate(reason.expiredOn)}`;
  }
}

function describeHold(
  { name }: MedicationChoice,
  reason: Exclude<IneligibilityReason, PrescriberReason>,
) {
  if (reason.rule === "too_early")
    return `It's too early to refill ${name}. Your current supply runs out on ${formatDate(reason.supplyEndsOn)}, and because it's a controlled medication, the earliest you can refill it is ${formatDate(reason.earliestRefillDate)}.`;
  const need = `${name} needs a recent ${reason.labType} lab test (one from the last ${reason.withinDays} days) before it can be refilled`;
  switch (reason.problem) {
    case "missing":
      return `${need}, and I don't see one on file.`;
    case "too_old":
      return `${need}, and the most recent ${reason.labType} result on file is from ${formatDate(reason.latestTakenOn)}.`;
    case "future_dated":
      return `${need}. The most recent ${reason.labType} result on file is dated ${formatDate(reason.latestTakenOn)}, which is after today, so the record may need to be corrected.`;
  }
}

// Reasons that all need a new prescription are stated once, together.
function describeReasons(
  medication: MedicationChoice,
  reasons: readonly IneligibilityReason[],
) {
  const prescriber = reasons.filter(isPrescriberReason);
  const holds = reasons.filter(
    (reason): reason is Exclude<IneligibilityReason, PrescriberReason> =>
      !isPrescriberReason(reason),
  );
  const sentences = prescriber.length
    ? [
        `${medication.name} can't be refilled here: ${listFormat.format(prescriber.map(prescriberClause))}. Your prescriber will need to send a new prescription.`,
      ]
    : [];
  return [
    ...sentences,
    ...holds.map((reason) => describeHold(medication, reason)),
  ];
}

export function ineligible(
  medication: MedicationChoice,
  eligibility: Extract<Eligibility, { eligible: false }>,
  alternatives: readonly MedicationChoice[] = [],
) {
  const next =
    eligibility.disposition === "hold" && alternatives.length
      ? `I haven't submitted it. Would you like to refill another prescription instead?\n${numbered(alternatives.map(({ name }) => name))}`
      : `I haven't submitted it. ${careTeamHandoff}`;
  return [...describeReasons(medication, eligibility.reasons), next].join(" ");
}

export const heldReferred = (medication: MedicationChoice) =>
  `Okay, I haven't submitted anything. I've referred your ${medication.name} request to your care team for review. If it's urgent, please contact your prescriber's office directly.`;

export function cannotContinue(kind: "failure" | "unanswered") {
  const blocker =
    kind === "failure"
      ? "I still can't complete this because of a problem with our systems"
      : "I haven't been able to complete this refill here";
  return `${blocker}, and nothing has been submitted. ${careTeamHandoff}`;
}

export function submitted(
  medication: MedicationChoice,
  pharmacy: PharmacyChoice,
  pharmacyChanged: boolean,
) {
  const change = pharmacyChanged
    ? ` ${pharmacy.name} is now your pharmacy on file.`
    : "";
  return `Your ${medication.name} refill has been submitted to ${pharmacy.name}.${change} ${pharmacy.name} will prepare it; you can contact them to check when it's ready.`;
}

export function pharmacyUpdateFailed(
  pharmacy: PharmacyChoice,
  current: PharmacyChoice | null,
) {
  const fallback =
    current && current.pharmacyId !== pharmacy.pharmacyId
      ? `, or say "keep ${current.name}" to send it to your current pharmacy instead`
      : ", or tell me a different pharmacy";
  return `I couldn't update your pharmacy to ${pharmacy.name}, so I haven't submitted the refill. Reply yes to try again${fallback}.`;
}

export const submissionRejected = (pharmacyChanged: boolean) =>
  `The pharmacy system did not accept this refill, so nothing was submitted.${pharmacyChanged ? " Your pharmacy on file was updated." : ""} Reply yes to try again, or contact your care team for help.`;

export const submissionUnknown = (
  pharmacy: PharmacyChoice,
  pharmacyChanged: boolean,
) =>
  `I couldn't confirm whether ${pharmacy.name} received this refill. To avoid sending it twice, I won't resend it, so please don't request it again here.${pharmacyChanged ? " Your pharmacy on file may have been updated." : ""} ${careTeamHandoff} You can also call ${pharmacy.name} to ask whether it arrived.`;

// The patient asked the agent to choose; it never does, but the current
// pharmacy is a safe, already-known destination to offer.
export const offerCurrentPharmacy = (current: PharmacyChoice) =>
  `I can't choose a new pharmacy for you, but I can send it to your current pharmacy, ${current.name}. Reply yes to do that, or give me a pharmacy name or street.`;

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

// Replies to any message after the conversation has ended.
export const after = {
  submitted: (medication: MedicationChoice, pharmacy: PharmacyChoice) =>
    `To confirm, your ${medication.name} refill was submitted to ${pharmacy.name} once, earlier in this conversation. There's nothing else you need to do; you can contact ${pharmacy.name} to check when it's ready.`,
  uncertain: (pharmacy: PharmacyChoice) =>
    `I can't check or resend this refill here. Your care team will look into whether ${pharmacy.name} received it, and you can also call ${pharmacy.name} directly.`,
  referred: (needsNewPrescription: boolean) =>
    `This request is with your care team now, so I can't change it here.${needsNewPrescription ? " If your doctor has approved it, they'll need to send a new prescription to your pharmacy." : ""} If it's urgent, please contact your prescriber's office directly.`,
  cancelled: () =>
    "This request was cancelled, and nothing was submitted. If you'd like a refill, please start a new conversation.",
  closed: () =>
    "Nothing else was submitted. If you need another refill, please start a new conversation.",
};

export function needsNewPrescription(
  eligibility: Extract<Eligibility, { eligible: false }>,
) {
  return eligibility.reasons.some(isPrescriberReason);
}
