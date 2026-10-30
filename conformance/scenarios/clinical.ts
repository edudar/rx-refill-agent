import type { ConformanceScenario } from "../contracts.js";
import { patientFixture } from "../fixtures.js";
import { beginRefill, completeRefill } from "../dialogue.js";
import {
  checkMedicationReview,
  checkNoSubmissionClaim,
  checkNoWrites,
  checkOnlyPatient,
  checkText,
} from "../assertions.js";

interface BlockedRefill {
  name: string;
  patientId: string;
  reason: RegExp;
  escalate?: boolean;
  requireClock?: boolean;
}

const blockedCases: readonly BlockedRefill[] = [
  {
    name: "schedule-ii",
    patientId: "pat_002",
    reason: /schedule\s*(?:II|2)|prescriber|new prescription/i,
    escalate: true,
    requireClock: false,
  },
  {
    name: "expired-no-refills",
    patientId: "pat_003",
    reason: /expir|no refills|new prescription|prescriber/i,
    escalate: true,
  },
  {
    name: "controlled-too-early",
    patientId: "pat_004",
    reason: /early|supply|wait|not.{0,20}due/i,
  },
  { name: "stale-lab", patientId: "pat_006", reason: /INR|lab|test|monitor/i },
  {
    name: "no-refills-only",
    patientId: "pat_013",
    reason:
      /no refills|refills.{0,20}(?:left|remain)|new prescription|prescriber/i,
    escalate: true,
  },
  {
    name: "expired-only",
    patientId: "pat_014",
    reason: /expir|new prescription|prescriber/i,
    escalate: true,
  },
  {
    name: "controlled-outside-window",
    patientId: "pat_018",
    reason: /early|supply|wait|not.{0,20}due/i,
  },
  {
    name: "lab-missing",
    patientId: "pat_015",
    reason: /INR|lab|test|monitor/i,
  },
  {
    name: "lab-wrong-type",
    patientId: "pat_016",
    reason: /INR|lab|test|monitor/i,
  },
  {
    name: "lab-outside-age",
    patientId: "pat_020",
    reason: /INR|lab|test|monitor/i,
  },
  {
    name: "lab-in-future",
    patientId: "pat_026",
    reason: /INR|lab|test|monitor/i,
  },
  {
    name: "expiration-yesterday",
    patientId: "pat_023",
    reason: /expir|new prescription|prescriber/i,
    escalate: true,
  },
];

function blockedRefill(spec: BlockedRefill): ConformanceScenario {
  return {
    name: spec.name,
    description: `Decline ${spec.patientId}'s refill: ${spec.name}; never attempt submission.`,
    async run(context) {
      const patient = patientFixture(spec.patientId);
      const { reply, calls } = await beginRefill(context, patient);
      checkOnlyPatient(context, calls, patient);
      checkMedicationReview(
        context,
        calls,
        patient,
        patient.medications[0].medId,
        spec.requireClock ?? true,
      );
      checkNoWrites(context, calls);
      checkNoSubmissionClaim(context, reply);
      context.check(
        spec.escalate
          ? reply.state === "escalated"
          : reply.state !== "complete",
        "clinical restriction did not produce the expected handoff/hold state",
      );
      checkText(
        context,
        reply,
        spec.reason,
        "clinical restriction was not explained",
      );
    },
  };
}

const allowedCases = [
  ["controlled-within-window", "pat_005"],
  ["non-controlled-early", "pat_010"],
  ["recent-lab", "pat_007"],
  ["controlled-exact-window", "pat_017"],
  ["lab-exact-age", "pat_019"],
  ["lab-multiple-results", "pat_021"],
  ["expiration-today", "pat_022"],
] as const;

export const clinicalScenarios: readonly ConformanceScenario[] = [
  ...blockedCases.map(blockedRefill),
  ...allowedCases.map(
    ([name, id]) =>
      ({
        name,
        description: `Approve ${id}'s eligible refill (${name}) only after pharmacy confirmation.`,
        async run(context) {
          await completeRefill(context, patientFixture(id));
        },
      }) satisfies ConformanceScenario,
  ),
];
