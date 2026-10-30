import type {
  ConversationStep,
  StepResult,
} from "../contracts/conversation.js";
import type { EhrClient, Medication } from "../contracts/ehr.js";
import type {
  PharmacyDirectory,
  PharmacyListing,
} from "../contracts/pharmacy.js";
import {
  refillUnderstandingSchema,
  type RefillInterpreter,
  type RefillQuestion,
  type RefillUnderstanding,
} from "../contracts/refill-interpretation.js";
import { ServiceRequestError } from "../contracts/service-errors.js";
import {
  conversationBase,
  type Conversation,
  type EndedConversation,
  type MedicationChoice,
  type PharmacyChoice,
  type RefillState,
  type VerifiedConversation,
} from "../domain/conversation.js";
import {
  findNamedPharmacy,
  matchMedications,
} from "../domain/refill-choices.js";
import { evaluateRefillEligibility } from "../domain/refill-eligibility.js";
import type { RefillGate, RefillGateOutcome } from "./refill-gate.js";
import * as say from "./refill-messages.js";

const MAX_PHARMACY_OPTIONS = 5;
const MAX_ECHOED_TEXT = 60;

interface RefillDependencies {
  // Reads only: every write goes through the gate.
  ehr: Pick<
    EhrClient,
    "getTime" | "getMedications" | "getLabs" | "getPharmacy"
  >;
  pharmacies: PharmacyDirectory;
  interpret: RefillInterpreter;
  gate: RefillGate;
}

type PharmacyStep = Extract<
  RefillState,
  { step: "choosing_pharmacy" | "confirming" }
>;

// The model only proposes what the patient said. Medications and pharmacies are
// resolved against retrieved records, and only a destination already shown to
// the patient can be confirmed. Replies use fixed wording from refill-messages.
export function createRefillFlow(
  deps: RefillDependencies,
): ConversationStep<VerifiedConversation> {
  return async (conversation, turn) => {
    try {
      // The handed-off message carried identity details, not an answer to us.
      if (turn.handedOff)
        return await startRefill(
          deps,
          { ...conversation, pendingIntent: undefined },
          conversation.pendingIntent?.medicationMention ?? null,
        );
      let understanding: RefillUnderstanding;
      try {
        understanding = refillUnderstandingSchema.parse(
          await deps.interpret({
            text: turn.text,
            question: questionFor(conversation.refill),
            lastPrompt: conversation.lastPrompt,
          }),
        );
      } catch {
        return reply(conversation, say.notUnderstood());
      }
      return await continueRefill(deps, conversation, understanding);
    } catch (error) {
      // Only reads can fail here; the gate reports write outcomes without throwing.
      return error instanceof ServiceRequestError
        ? reply(conversation, say.servicesUnavailable())
        : reply(ended(conversation, "escalated"), say.cannotProcess());
    }
  };
}

function continueRefill(
  deps: RefillDependencies,
  conversation: VerifiedConversation,
  understanding: RefillUnderstanding,
): Promise<StepResult> | StepResult {
  const { refill } = conversation;
  if (understanding.outOfScope)
    return reply(conversation, say.scopeRedirect(reprompt(refill)));
  if (understanding.intent === "cancel")
    return reply(ended(conversation, "complete"), say.cancelled());
  const mention = understanding.medicationMention;
  if (
    mention &&
    refill?.step !== "choosing_medication" &&
    !namesSelectedMedication(refill, mention)
  )
    return startRefill(deps, conversation, mention);
  switch (refill?.step) {
    case undefined:
      return understanding.intent === "decline"
        ? reply(ended(conversation, "complete"), say.closing())
        : startRefill(deps, conversation, null);
    case "choosing_medication":
      return pickMedication(deps, conversation, refill, understanding);
    case "choosing_pharmacy":
    case "confirming":
      return handlePharmacy(deps, conversation, refill, understanding);
  }
}

async function startRefill(
  deps: RefillDependencies,
  conversation: VerifiedConversation,
  mention: string | null,
): Promise<StepResult> {
  const medications = await deps.ehr.getMedications(
    conversation.patient.patientId,
  );
  const options = medications.map(medicationChoice);
  if (!options.length)
    return reply(ended(conversation, "escalated"), say.noMedications());
  if (!mention) return askMedication(conversation, options);
  const matches = matchMedications(mention, medications);
  if (matches.length === 1)
    return reviewMedication(deps, conversation, matches[0]);
  if (matches.length > 1)
    return askMedication(conversation, matches.map(medicationChoice));
  return askMedication(conversation, options, echo(mention));
}

function askMedication(
  conversation: VerifiedConversation,
  options: MedicationChoice[],
  notOnRecord?: string,
) {
  return reply(
    withRefill(conversation, { step: "choosing_medication", options }),
    say.chooseMedication(options, notOnRecord),
  );
}

async function pickMedication(
  deps: RefillDependencies,
  conversation: VerifiedConversation,
  refill: Extract<RefillState, { step: "choosing_medication" }>,
  { optionNumber, medicationMention, intent }: RefillUnderstanding,
) {
  const { options } = refill;
  const named = medicationMention
    ? matchMedications(medicationMention, options)
    : [];
  const chosen =
    (optionNumber ? options[optionNumber - 1] : undefined) ??
    (named.length === 1 ? named[0] : undefined) ??
    (options.length === 1 && intent === "confirm" ? options[0] : undefined);
  if (chosen) return selectMedication(deps, conversation, chosen);
  if (medicationMention)
    return startRefill(deps, conversation, medicationMention);
  return reply(conversation, say.chooseMedication(options));
}

// Options are shown from an earlier read; the record is read again before use.
async function selectMedication(
  deps: RefillDependencies,
  conversation: VerifiedConversation,
  choice: MedicationChoice,
) {
  const medications = await deps.ehr.getMedications(
    conversation.patient.patientId,
  );
  const medication = medications.find(({ medId }) => medId === choice.medId);
  return medication
    ? reviewMedication(deps, conversation, medication)
    : askMedication(conversation, medications.map(medicationChoice));
}

// The gate repeats this check at submission; this one decides what to offer.
async function reviewMedication(
  deps: RefillDependencies,
  conversation: VerifiedConversation,
  medication: Medication,
): Promise<StepResult> {
  const { patientId } = conversation.patient;
  const required = medication.requiresRecentLab;
  const [now, labs] = await Promise.all([
    deps.ehr.getTime(),
    required ? deps.ehr.getLabs(patientId, required.type) : [],
  ]);
  const eligibility = evaluateRefillEligibility(medication, labs, now);
  const choice = medicationChoice(medication);
  if (!eligibility.eligible)
    return reply(
      eligibility.disposition === "escalate"
        ? ended(conversation, "escalated")
        : withRefill(conversation, undefined),
      say.ineligible(choice, eligibility),
    );
  const pharmacy = await deps.ehr.getPharmacy(patientId);
  const current = pharmacy && {
    pharmacyId: pharmacy.pharmacyId,
    name: pharmacy.name,
  };
  if (!current)
    return reply(
      withRefill(conversation, {
        step: "choosing_pharmacy",
        medication: choice,
        current: null,
        options: [],
        presented: [],
      }),
      say.askForPharmacy(false),
    );
  return propose(conversation, choice, current, current, [current]);
}

function propose(
  conversation: VerifiedConversation,
  medication: MedicationChoice,
  current: PharmacyChoice | null,
  pharmacy: PharmacyChoice,
  presented: PharmacyChoice[],
) {
  return reply(
    withRefill(conversation, {
      step: "confirming",
      medication,
      current,
      pharmacy,
      presented: distinctPharmacies(presented),
    }),
    say.confirmRefill(medication, pharmacy, current),
  );
}

async function handlePharmacy(
  deps: RefillDependencies,
  conversation: VerifiedConversation,
  refill: PharmacyStep,
  understanding: RefillUnderstanding,
): Promise<StepResult> {
  const { medication, current, presented } = refill;
  const named = namedDestination(refill, understanding);
  if (named)
    return understanding.intent === "confirm"
      ? submit(deps, conversation, refill, named)
      : propose(conversation, medication, current, named, [
          ...presented,
          named,
        ]);
  if (understanding.pharmacyName || understanding.pharmacyLocation)
    return searchPharmacies(deps, conversation, refill, understanding);
  if (refill.step === "confirming") {
    if (understanding.intent === "confirm")
      return submit(deps, conversation, refill, refill.pharmacy);
    if (understanding.intent === "change_pharmacy")
      return reply(
        withRefill(conversation, {
          step: "choosing_pharmacy",
          medication,
          current,
          options: [],
          presented,
        }),
        say.askForPharmacy(current !== null),
      );
    if (understanding.intent === "decline")
      return reply(conversation, say.confirmationDeclined());
  }
  return reply(conversation, reprompt(refill));
}

// Only destinations already shown to the patient can be chosen by name or number.
function namedDestination(
  refill: PharmacyStep,
  { keepCurrentPharmacy, optionNumber, pharmacyName }: RefillUnderstanding,
): PharmacyChoice | undefined {
  if (pharmacyName) return findNamedPharmacy(pharmacyName, refill.presented);
  if (keepCurrentPharmacy && refill.current) return refill.current;
  if (refill.step === "choosing_pharmacy" && optionNumber)
    return refill.options[optionNumber - 1];
}

async function searchPharmacies(
  deps: RefillDependencies,
  conversation: VerifiedConversation,
  refill: PharmacyStep,
  { pharmacyName, pharmacyLocation }: RefillUnderstanding,
) {
  const { medication, current, presented } = refill;
  const options = (
    await findPharmacies(deps.pharmacies, pharmacyName, pharmacyLocation)
  )
    .slice(0, MAX_PHARMACY_OPTIONS)
    .map(pharmacyChoice);
  if (options.length === 1)
    return propose(conversation, medication, current, options[0], [
      ...presented,
      options[0],
    ]);
  const next = withRefill(conversation, {
    step: "choosing_pharmacy",
    medication,
    current,
    options,
    presented: distinctPharmacies([...presented, ...options]),
  });
  return options.length
    ? reply(next, say.choosePharmacy(options))
    : reply(
        next,
        say.pharmacyNotFound(echo(pharmacyName ?? pharmacyLocation ?? "")),
      );
}

// Searches by name; a location only narrows several name matches, so an unknown
// name never turns into unrelated pharmacies that happen to share a street.
async function findPharmacies(
  directory: PharmacyDirectory,
  name: string | null,
  location: string | null,
): Promise<PharmacyListing[]> {
  const query = (name ?? location ?? "").trim().slice(0, 100);
  if (!query) return [];
  const results = await directory.search(query);
  if (!name || !location || results.length < 2) return results;
  const area = location.toLowerCase();
  const narrowed = results.filter(
    (pharmacy) =>
      pharmacy.address.toLowerCase().includes(area) ||
      area.includes(pharmacy.address.toLowerCase().split(",")[0]),
  );
  return narrowed.length ? narrowed : results;
}

async function submit(
  deps: RefillDependencies,
  conversation: VerifiedConversation,
  refill: PharmacyStep,
  pharmacy: PharmacyChoice,
): Promise<StepResult> {
  const { medication } = refill;
  const outcome = await deps.gate.submit(conversation, {
    patientId: conversation.patient.patientId,
    medId: medication.medId,
    pharmacyId: pharmacy.pharmacyId,
  });
  return respondToOutcome(conversation, refill, pharmacy, outcome);
}

function respondToOutcome(
  conversation: VerifiedConversation,
  refill: PharmacyStep,
  pharmacy: PharmacyChoice,
  outcome: RefillGateOutcome,
): StepResult {
  const { medication } = refill;
  // A retry after an outage confirms the same destination again.
  const retry = (current = refill.current) =>
    withRefill(conversation, {
      step: "confirming",
      medication,
      current,
      pharmacy,
      presented: distinctPharmacies([...refill.presented, pharmacy]),
    });
  switch (outcome.status) {
    case "submitted":
      return reply(
        ended(conversation, "complete"),
        say.submitted(medication, pharmacy, outcome.pharmacyChanged),
      );
    case "ineligible":
      return reply(
        outcome.eligibility.disposition === "escalate"
          ? ended(conversation, "escalated")
          : withRefill(conversation, undefined),
        say.ineligible(medication, outcome.eligibility),
      );
    case "unavailable":
      return reply(retry(), say.servicesUnavailable());
    case "pharmacy_update_failed":
      return reply(retry(), say.pharmacyUpdateFailed(pharmacy));
    case "submission_rejected":
      return reply(
        retry(outcome.pharmacyChanged ? pharmacy : refill.current),
        say.submissionRejected(outcome.pharmacyChanged),
      );
    case "submission_unknown":
      return reply(
        ended(conversation, "escalated"),
        say.submissionUnknown(outcome.pharmacyChanged),
      );
    case "not_authorized":
    case "medication_not_found":
    case "cannot_evaluate":
      return reply(ended(conversation, "escalated"), say.cannotProcess());
  }
}

function questionFor(refill: RefillState | undefined): RefillQuestion {
  switch (refill?.step) {
    case undefined:
      return "anything_else";
    case "choosing_medication":
      return "which_medication";
    case "choosing_pharmacy":
      return "which_pharmacy";
    case "confirming":
      return "confirm_refill";
  }
}

function reprompt(refill: RefillState | undefined) {
  switch (refill?.step) {
    case undefined:
      return say.anythingElse();
    case "choosing_medication":
      return say.chooseMedication(refill.options);
    case "choosing_pharmacy":
      return refill.options.length
        ? say.choosePharmacy(refill.options)
        : say.askForPharmacy(refill.current !== null);
    case "confirming":
      return say.confirmRefill(
        refill.medication,
        refill.pharmacy,
        refill.current,
      );
  }
}

function namesSelectedMedication(
  refill: RefillState | undefined,
  mention: string,
) {
  return (
    !!refill &&
    "medication" in refill &&
    matchMedications(mention, [refill.medication]).length === 1
  );
}

function medicationChoice({ medId, name }: Medication): MedicationChoice {
  return { medId, name };
}

function pharmacyChoice({
  pharmacyId,
  name,
  address,
}: PharmacyListing): PharmacyChoice {
  return { pharmacyId, name, address };
}

function distinctPharmacies(pharmacies: PharmacyChoice[]) {
  return [
    ...new Map(
      pharmacies.map((pharmacy) => [pharmacy.pharmacyId, pharmacy]),
    ).values(),
  ];
}

// Patient wording echoed back is single-line and short.
function echo(text: string) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_ECHOED_TEXT
    ? `${line.slice(0, MAX_ECHOED_TEXT)}…`
    : line;
}

function withRefill(
  conversation: VerifiedConversation,
  refill: RefillState | undefined,
): VerifiedConversation {
  return { ...conversation, refill };
}

function ended(
  conversation: Conversation,
  outcome: EndedConversation["outcome"],
): EndedConversation {
  return { ...conversationBase(conversation), phase: "ended", outcome };
}

function reply(conversation: Conversation, text: string): StepResult {
  return {
    conversation,
    messages: [{ from: "agent", text }],
    next: "reply",
  };
}
