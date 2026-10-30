import type { LabResult, Medication } from "../contracts/ehr.js";

const DAY_MS = 86_400_000;
const CONTROLLED_EARLY_REFILL_DAYS = 2;
const SCHEDULES_WITH_EARLY_REFILL_LIMIT = new Set(["CIII", "CIV", "CV"]);

export type IneligibilityReason =
  | { rule: "schedule_ii" }
  | { rule: "no_refills" }
  | { rule: "expired"; expiredOn: string }
  | { rule: "too_early"; earliestRefillDate: string }
  | { rule: "lab_required"; labType: string; withinDays: number };

// escalate: a prescriber must act (docs/API.md R1, R2).
// hold: the refill may become possible later (R3, R4).
export type Eligibility =
  | { eligible: true }
  | {
      eligible: false;
      disposition: "escalate" | "hold";
      reasons: IneligibilityReason[];
    };

const escalatingRules = new Set<IneligibilityReason["rule"]>([
  "schedule_ii",
  "no_refills",
  "expired",
]);

// All rules use UTC calendar days of the EHR clock. Expiration day, the first
// allowed early-refill day, and a lab exactly withinDays old are all allowed.
export function evaluateRefillEligibility(
  medication: Medication,
  labs: readonly LabResult[],
  now: string,
): Eligibility {
  const today = utcDay(now);
  const reasons = [
    scheduleIiRule(medication),
    noRefillsRule(medication),
    expirationRule(medication, today),
    earlyRefillRule(medication, today),
    recentLabRule(medication, labs, today),
  ].filter((reason) => reason !== undefined);
  if (!reasons.length) return { eligible: true };
  return {
    eligible: false,
    disposition: reasons.some(({ rule }) => escalatingRules.has(rule))
      ? "escalate"
      : "hold",
    reasons,
  };
}

function scheduleIiRule(
  medication: Medication,
): IneligibilityReason | undefined {
  if (medication.schedule === "CII") return { rule: "schedule_ii" };
}

function noRefillsRule(
  medication: Medication,
): IneligibilityReason | undefined {
  if (medication.refillsRemaining <= 0) return { rule: "no_refills" };
}

function expirationRule(
  medication: Medication,
  today: number,
): IneligibilityReason | undefined {
  if (calendarDay(medication.rxExpirationDate) < today)
    return { rule: "expired", expiredOn: medication.rxExpirationDate };
}

function earlyRefillRule(
  medication: Medication,
  today: number,
): IneligibilityReason | undefined {
  if (!hasEarlyRefillLimit(medication)) return;
  const earliest =
    calendarDay(medication.lastFilledDate) +
    medication.daysSupply -
    CONTROLLED_EARLY_REFILL_DAYS;
  if (today < earliest)
    return { rule: "too_early", earliestRefillDate: isoDate(earliest) };
}

// A controlled flag without a schedule still gets the stricter rule; Schedule II
// is never refillable here, so its early-refill window is irrelevant.
function hasEarlyRefillLimit({ isControlled, schedule }: Medication) {
  if (schedule === "CII") return false;
  return isControlled || SCHEDULES_WITH_EARLY_REFILL_LIMIT.has(schedule ?? "");
}

function recentLabRule(
  medication: Medication,
  labs: readonly LabResult[],
  today: number,
): IneligibilityReason | undefined {
  const required = medication.requiresRecentLab;
  if (!required) return;
  const type = normalizeLabType(required.type);
  const qualifies = labs.some((lab) => {
    const taken = calendarDay(lab.takenDate);
    return (
      normalizeLabType(lab.type) === type &&
      taken <= today &&
      taken >= today - required.withinDays
    );
  });
  if (!qualifies)
    return {
      rule: "lab_required",
      labType: required.type,
      withinDays: required.withinDays,
    };
}

function normalizeLabType(type: string) {
  return type.trim().toUpperCase();
}

function utcDay(instant: string) {
  const time = Date.parse(instant);
  if (Number.isNaN(time)) throw new Error("Invalid EHR clock");
  return Math.floor(time / DAY_MS);
}

function calendarDay(date: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error("Invalid calendar date");
  const [, year, month, day] = match.map(Number);
  const result = Date.UTC(year, month - 1, day) / DAY_MS;
  // Date.UTC rolls 2026-02-31 into March; reject it rather than shift the rule.
  if (isoDate(result) !== date) throw new Error("Invalid calendar date");
  return result;
}

function isoDate(day: number) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
