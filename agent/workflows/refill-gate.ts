import {
  EhrRequestError,
  type EhrClient,
  type Medication,
} from "../contracts/ehr.js";
import type { VerifiedConversation } from "../domain/conversation.js";
import {
  evaluateRefillEligibility,
  type Eligibility,
} from "../domain/refill-eligibility.js";

const LEDGER_RETENTION_MS = 24 * 60 * 60 * 1_000;

// The exact medication and destination the patient explicitly confirmed.
export interface RefillOrder {
  patientId: string;
  medId: string;
  pharmacyId: string;
}

export type RefillGateOutcome =
  | { status: "submitted"; refillId: string; pharmacyChanged: boolean }
  | { status: "already_submitted"; refillId: string }
  // Another conversation is submitting this refill right now.
  | { status: "submission_in_progress" }
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

type LedgerEntry =
  | { status: "in_flight"; at: number }
  | { status: "submitted"; refillId: string; at: number }
  | { status: "unknown"; at: number };

// Every EHR write goes through here. The gate re-reads the clock, medication,
// and labs, re-applies the clinical rules, and keeps a submission ledger outside
// conversation state, so a rolled-back turn, an evicted conversation, or a second
// conversation for the same patient cannot repeat a non-idempotent refill.
export function createRefillGate(options: {
  ehr: EhrClient;
  now?: () => number;
}): RefillGate {
  const { ehr } = options;
  const now = options.now ?? Date.now;
  const ledger = new Map<string, LedgerEntry>();
  return {
    async submit(conversation, order) {
      if (order.patientId !== conversation.patient.patientId)
        return { status: "not_authorized" };
      pruneLedger(ledger, now());
      const key = `${order.patientId}\u0000${order.medId}`;
      const previous = ledger.get(key);
      if (previous) return previousSubmission(previous);
      // Claimed before any await so concurrent conversations cannot both submit.
      ledger.set(key, { status: "in_flight", at: now() });
      let outcome: RefillGateOutcome;
      try {
        outcome = await submitChecked(ehr, order);
      } catch {
        // Unreachable by design; if it happens, assume the refill may have been sent.
        outcome = { status: "submission_unknown", pharmacyChanged: false };
      }
      recordOutcome(ledger, key, outcome, now());
      return outcome;
    },
  };
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
    return error instanceof EhrRequestError
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
    return error instanceof EhrRequestError && error.kind === "rejected"
      ? { status: "submission_rejected", pharmacyChanged }
      : { status: "submission_unknown", pharmacyChanged };
  }
}

function previousSubmission(entry: LedgerEntry): RefillGateOutcome {
  switch (entry.status) {
    case "submitted":
      return { status: "already_submitted", refillId: entry.refillId };
    case "in_flight":
      return { status: "submission_in_progress" };
    case "unknown":
      return { status: "submission_unknown", pharmacyChanged: false };
  }
}

function recordOutcome(
  ledger: Map<string, LedgerEntry>,
  key: string,
  outcome: RefillGateOutcome,
  at: number,
) {
  if (outcome.status === "submitted")
    ledger.set(key, { status: "submitted", refillId: outcome.refillId, at });
  else if (outcome.status === "submission_unknown")
    ledger.set(key, { status: "unknown", at });
  // Every other outcome wrote no refill, so the patient may try again.
  else ledger.delete(key);
}

function pruneLedger(ledger: Map<string, LedgerEntry>, at: number) {
  for (const [key, entry] of ledger)
    if (entry.status !== "in_flight" && at - entry.at >= LEDGER_RETENTION_MS)
      ledger.delete(key);
}
