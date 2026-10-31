import type { EhrClient, Medication } from "../contracts/ehr.js";
import { ServiceRequestError } from "../contracts/service-errors.js";
import type { VerifiedConversation } from "../domain/conversation.js";
import {
  evaluateRefillEligibility,
  type Eligibility,
} from "../domain/refill-eligibility.js";

// The exact medication and destination the patient explicitly confirmed.
export interface RefillOrder {
  patientId: string;
  medId: string;
  pharmacyId: string;
}

export type RefillGateOutcome =
  | { status: "submitted"; refillId: string; pharmacyChanged: boolean }
  | {
      status: "ineligible";
      eligibility: Extract<Eligibility, { eligible: false }>;
    }
  // Nothing was written; the patient may try again.
  | { status: "unavailable" }
  | { status: "pharmacy_update_failed" }
  | { status: "submission_rejected"; pharmacyChanged: boolean }
  // The EHR may have accepted the refill. It is never retried; a human must check.
  | { status: "submission_unknown"; pharmacyChanged: boolean }
  // The request cannot be evaluated as given; a human must review it.
  | { status: "not_authorized" }
  | { status: "medication_not_found" }
  | { status: "cannot_evaluate" };

export interface RefillGate {
  submit(
    conversation: VerifiedConversation,
    order: RefillOrder,
  ): Promise<RefillGateOutcome>;
}

// Every EHR write goes through here. The gate re-reads the clock, medication,
// and labs, re-applies the clinical rules, and submits at most once per call.
// It keeps no record of outcomes: repeats within a conversation are prevented
// by the phase machine (a submitted or uncertain refill ends the conversation),
// and nothing carries over between conversations, because the EHR offers no
// refill history to tell a duplicate from a new request.
//
// The pharmacy belongs to the patient, not the conversation, so the review,
// pharmacy update, and submission run one patient at a time in this process.
// Otherwise two conversations could interleave setPharmacy(A), setPharmacy(B),
// and both submissions, sending A's refill to B.
export function createRefillGate(options: { ehr: EhrClient }): RefillGate {
  const { ehr } = options;
  const inFlight = new Map<string, Promise<RefillGateOutcome>>();
  return {
    async submit(conversation, order) {
      if (order.patientId !== conversation.patient.patientId)
        return { status: "not_authorized" };
      return oneAtATime(inFlight, order.patientId, async () => {
        try {
          return await submitChecked(ehr, order);
        } catch {
          // Unreachable by design; if it happens, assume the refill may have been sent.
          return { status: "submission_unknown", pharmacyChanged: false };
        }
      });
    },
  };
}

// Runs after any earlier call for the same key; the entry is removed once idle.
function oneAtATime(
  inFlight: Map<string, Promise<RefillGateOutcome>>,
  key: string,
  run: () => Promise<RefillGateOutcome>,
) {
  const previous = inFlight.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  inFlight.set(key, next);
  void next.finally(() => {
    if (inFlight.get(key) === next) inFlight.delete(key);
  });
  return next;
}

async function submitChecked(
  ehr: EhrClient,
  order: RefillOrder,
): Promise<RefillGateOutcome> {
  const review = await reviewEligibility(ehr, order);
  if (review.status !== "eligible") return review;
  const pharmacy = await ensurePharmacy(ehr, order);
  if (pharmacy.status !== "ready") return pharmacy;
  return postRefill(ehr, order, pharmacy.changed);
}

async function reviewEligibility(
  ehr: EhrClient,
  { patientId, medId }: RefillOrder,
): Promise<{ status: "eligible" } | RefillGateOutcome> {
  let medication: Medication | undefined;
  let eligibility: Eligibility;
  try {
    const [now, medications] = await Promise.all([
      ehr.getTime(),
      ehr.getMedications(patientId),
    ]);
    medication = medications.find((candidate) => candidate.medId === medId);
    if (!medication) return { status: "medication_not_found" };
    const required = medication.requiresRecentLab;
    const labs = required ? await ehr.getLabs(patientId, required.type) : [];
    eligibility = evaluateRefillEligibility(medication, labs, now);
  } catch (error) {
    return error instanceof ServiceRequestError
      ? { status: "unavailable" }
      : { status: "cannot_evaluate" };
  }
  return eligibility.eligible
    ? { status: "eligible" }
    : { status: "ineligible", eligibility };
}

// Setting the destination is idempotent, so a failed update is safe to retry,
// but the refill is never submitted unless the update succeeded.
async function ensurePharmacy(
  ehr: EhrClient,
  { patientId, pharmacyId }: RefillOrder,
): Promise<{ status: "ready"; changed: boolean } | RefillGateOutcome> {
  try {
    const current = await ehr.getPharmacy(patientId);
    if (current?.pharmacyId === pharmacyId)
      return { status: "ready", changed: false };
  } catch {
    return { status: "unavailable" };
  }
  try {
    await ehr.setPharmacy(patientId, pharmacyId);
  } catch {
    return { status: "pharmacy_update_failed" };
  }
  return { status: "ready", changed: true };
}

// Only a 4xx proves the EHR refused the refill. A 5xx, timeout, dropped
// connection, or unreadable success may hide an accepted submission.
async function postRefill(
  ehr: EhrClient,
  { patientId, medId }: RefillOrder,
  pharmacyChanged: boolean,
): Promise<RefillGateOutcome> {
  try {
    const { refillId } = await ehr.submitRefill(patientId, medId);
    return { status: "submitted", refillId, pharmacyChanged };
  } catch (error) {
    return error instanceof ServiceRequestError && error.kind === "rejected"
      ? { status: "submission_rejected", pharmacyChanged }
      : { status: "submission_unknown", pharmacyChanged };
  }
}
