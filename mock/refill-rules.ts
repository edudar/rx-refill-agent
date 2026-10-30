import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import type { Lab, Medication, RequiresRecentLab } from "./types.js";

dayjs.extend(utc);

export function parseSimulatedDay(now: string) {
  const today = dayjs.utc(now).startOf("day");
  if (!today.isValid()) throw new Error("Invalid simulated clock");
  return today;
}

// Independent mock backstop. The agent must reject these before attempting POST.
export function refillRejection(
  medication: Medication,
  labs: Lab[],
  now: string,
) {
  const today = parseSimulatedDay(now);
  if (medication.schedule === "CII") return "schedule_ii";
  if (medication.refillsRemaining <= 0) return "no_refills";
  if (dayjs.utc(medication.rxExpirationDate).isBefore(today))
    return "prescription_expired";
  if (isControlledRefillTooEarly(medication, today))
    return "controlled_refill_too_early";
  if (
    medication.requiresRecentLab &&
    !hasRecentLab(labs, medication.requiresRecentLab, today)
  )
    return "recent_lab_required";
  return undefined;
}

function isControlledRefillTooEarly(
  medication: Medication,
  today: dayjs.Dayjs,
) {
  return (
    medication.schedule &&
    ["CIII", "CIV", "CV"].includes(medication.schedule) &&
    today.isBefore(
      dayjs
        .utc(medication.lastFilledDate)
        .add(medication.daysSupply, "day")
        .subtract(2, "day"),
    )
  );
}

function hasRecentLab(
  labs: Lab[],
  requirement: RequiresRecentLab,
  today: dayjs.Dayjs,
) {
  return labs.some((lab) => {
    const taken = dayjs.utc(lab.takenDate);
    return (
      taken.isValid() &&
      lab.type.toLowerCase() === requirement.type.toLowerCase() &&
      !taken.isAfter(today) &&
      !taken.isBefore(today.subtract(requirement.withinDays, "day"))
    );
  });
}
