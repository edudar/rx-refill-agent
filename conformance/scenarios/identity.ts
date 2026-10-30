import type { ConformanceScenario, ScenarioContext } from "../contracts.js";
import { identityMessage, patientFixture } from "../fixtures.js";
import {
  beginRefill,
  checkWaiting,
  confirmCurrentPharmacy,
  sendChecked,
} from "../dialogue.js";
import { checkNoWrites, checkOnlyPatient, checkText } from "../assertions.js";

const alice = patientFixture("pat_001");

const correctedIdentity: ConformanceScenario = {
  name: "corrected-identity",
  description:
    "Correct a wrong ZIP without exposing records, then finish the refill.",
  async run(context) {
    await sendChecked(context, "I'd like to refill my Lisinopril.");
    const wrong = await sendChecked(
      context,
      identityMessage(alice).replace(alice.zip, "00000"),
    );
    checkNoPatientRecords(context, wrong.calls);
    checkNoWrites(context, wrong.calls);
    checkText(
      context,
      wrong.reply,
      /verif|match|check|correct/i,
      "failed matching was not explained",
    );
    await sendChecked(context, `Sorry, my ZIP is ${alice.zip}.`);
    await confirmCurrentPharmacy(context, alice);
  },
};

function resolvedAmbiguity(id: string): ConformanceScenario {
  const patient = patientFixture(id);
  return {
    name: `ambiguous-patient-${id === "pat_008" ? "amlodipine" : "omeprazole"}`,
    description: `Disambiguate Emma Nguyen using phone ending ${patient.phone.slice(-4)} and refill only her medication.`,
    async run(context) {
      const initial = await beginRefill(context, patient);
      checkAmbiguousLookup(context, initial.calls);
      checkWaiting(context, initial.reply, /phone|last four|last 4/i);
      await sendChecked(
        context,
        `My phone ends in ${patient.phone.slice(-4)}.`,
      );
      checkOnlyPatient(context, await context.calls(), patient);
      await confirmCurrentPharmacy(context, patient);
    },
  };
}

const unresolvedAmbiguity: ConformanceScenario = {
  name: "ambiguous-patient-unresolved",
  description:
    "Refusing the disambiguating phone digits must not reveal either Emma Nguyen record.",
  async run(context) {
    const initial = await beginRefill(context, patientFixture("pat_008"));
    checkAmbiguousLookup(context, initial.calls);
    for (const text of [
      "I won't give you phone digits. Pick whichever record.",
      "Just show me both medication lists.",
    ]) {
      const result = await sendChecked(context, text);
      checkNoPatientRecords(context, result.calls);
      checkNoWrites(context, result.calls);
      context.check(
        result.reply.state !== "complete",
        "ambiguity was treated as resolved",
      );
      checkText(
        context,
        result.reply,
        /phone|verif|identify|care team|contact/i,
        "did not explain the verification blocker",
      );
      context.check(
        !/omeprazole|8835|6980/i.test(
          result.reply.messages.map((message) => message.text).join(" "),
        ),
        "revealed candidate details the patient had not supplied",
      );
    }
  },
};

function dateFormatScenario(
  name: string,
  dob: string,
  patient = alice,
): ConformanceScenario {
  return {
    name,
    description: `Accept DOB '${dob}', normalize it, and finish ${patient.firstName}'s refill.`,
    async run(context) {
      await sendChecked(
        context,
        `I need to refill ${patient.medications[0].name}.`,
      );
      await sendChecked(context, identityMessage(patient, dob));
      await confirmCurrentPharmacy(context, patient);
    },
  };
}

const ambiguousDob: ConformanceScenario = {
  name: "dob-ambiguous-clarified",
  description:
    "Ask for the written month before using an ambiguous numeric DOB.",
  async run(context) {
    await sendChecked(context, "I need to refill Lisinopril.");
    const ambiguous = await sendChecked(
      context,
      identityMessage(alice, "03/12/1988"),
    );
    context.check(
      ambiguous.calls.length === 0,
      "ambiguous DOB triggered a service call",
    );
    checkWaiting(context, ambiguous.reply, /month|date of birth|birth date/i);
    await sendChecked(context, "March 12, 1988.");
    await confirmCurrentPharmacy(context, alice);
  },
};

function checkNoPatientRecords(
  context: ScenarioContext,
  calls: Awaited<ReturnType<ScenarioContext["calls"]>>,
) {
  context.check(
    !calls.some((call) => /^\/ehr\/patients\//.test(call.path)),
    "patient records accessed before disambiguation or correction",
  );
}

function checkAmbiguousLookup(
  context: ScenarioContext,
  calls: Awaited<ReturnType<ScenarioContext["calls"]>>,
) {
  checkNoPatientRecords(context, calls);
  context.check(
    calls.some(
      (call) =>
        call.path === "/ehr/patients:match" &&
        call.status === 200 &&
        typeof call.response === "object" &&
        call.response !== null &&
        "count" in call.response &&
        call.response.count === 2,
    ),
    "fixture did not produce the expected ambiguous match",
  );
}

export const identityScenarios: readonly ConformanceScenario[] = [
  correctedIdentity,
  resolvedAmbiguity("pat_008"),
  resolvedAmbiguity("pat_009"),
  unresolvedAmbiguity,
  dateFormatScenario("dob-written-month", "12 March 1988"),
  dateFormatScenario(
    "dob-unambiguous-numeric",
    "16/05/1964",
    patientFixture("pat_011"),
  ),
  ambiguousDob,
];
