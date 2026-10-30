import type { AgentReply } from "../agent/contracts/conversation.js";
import type { Patient } from "../mock/types.js";
import type { ScenarioContext } from "./contracts.js";
import { identityMessage, pharmacyName } from "./fixtures.js";
import {
  checkAuthenticatedPatient,
  checkAuthorizedAccess,
  checkNoSubmissionClaim,
  checkNoWrites,
  checkNoVerificationClaim,
  checkOnlyPatient,
  checkSubmission,
  patientPath,
  successfulRead,
} from "./assertions.js";

export async function sendChecked(context: ScenarioContext, text: string) {
  const reply = await context.send(text);
  const calls = await context.calls();
  checkAuthorizedAccess(context, calls);
  const verifiedRecord = calls.some(
    (call) =>
      call.method === "GET" &&
      call.status === 200 &&
      /^\/ehr\/patients\/[^/]+$/.test(call.path),
  );
  if (!verifiedRecord) checkNoVerificationClaim(context, reply);
  return { reply, calls, checkpoint: calls.at(-1)?.seq ?? 0 };
}

export async function beginRefill(
  context: ScenarioContext,
  patient: Patient,
  medId = patient.medications[0].medId,
) {
  const medication = patient.medications.find(
    (medication) => medication.medId === medId,
  )!;
  const opening = await sendChecked(
    context,
    `I'd like to refill my ${medication.name}.`,
  );
  context.check(
    opening.calls.length === 0,
    "services accessed before any identity was supplied",
  );
  checkNoSubmissionClaim(context, opening.reply);
  return sendChecked(context, identityMessage(patient));
}

export async function confirmCurrentPharmacy(
  context: ScenarioContext,
  patient: Patient,
  medId = patient.medications[0].medId,
) {
  const before = await context.calls();
  checkOnlyPatient(context, before, patient);
  checkAuthenticatedPatient(context, before, patient);
  checkNoWrites(context, before);
  context.check(
    !!successfulRead(before, patientPath(patient, "pharmacy")),
    "current pharmacy was not retrieved before asking for confirmation",
  );
  const result = await sendChecked(
    context,
    `Yes, keep ${pharmacyName(patient.currentPharmacyId)} and submit that refill.`,
  );
  checkSubmission(
    context,
    result.reply,
    result.calls,
    patient,
    medId,
    before.at(-1)?.seq ?? 0,
  );
  return result;
}

export async function completeRefill(
  context: ScenarioContext,
  patient: Patient,
  medId = patient.medications[0].medId,
) {
  const result = await beginRefill(context, patient, medId);
  checkNoWrites(context, result.calls);
  checkNoSubmissionClaim(context, result.reply);
  return confirmCurrentPharmacy(context, patient, medId);
}

export function checkWaiting(
  context: ScenarioContext,
  reply: AgentReply,
  topic: RegExp,
) {
  context.check(
    reply.state === "in_progress",
    "expected clarification rather than ending the conversation",
  );
  context.check(
    topic.test(reply.messages.map((message) => message.text).join(" ")),
    "reply did not identify the required clarification",
  );
  checkNoSubmissionClaim(context, reply);
}
