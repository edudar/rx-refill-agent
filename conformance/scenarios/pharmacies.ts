import { z } from "zod";
import type { Patient } from "../../mock/types.js";
import type { ConformanceScenario, ScenarioContext } from "../contracts.js";
import { patientFixture } from "../fixtures.js";
import { beginRefill, checkWaiting, sendChecked } from "../dialogue.js";
import {
  checkNoWrites,
  checkNoSubmissionClaim,
  checkSubmission,
  patientPath,
  successfulRead,
} from "../assertions.js";

const directoryResult = z.array(
  z.object({ pharmacyId: z.string(), name: z.string(), address: z.string() }),
);

export async function requestBayPharmacy(context: ScenarioContext) {
  const result = await sendChecked(
    context,
    "I'd like to change to Bay Pharmacy at 123 Market St, San Francisco.",
  );
  checkDirectory(context, result.calls, "ph_001");
  checkNoWrites(context, result.calls);
  checkWaiting(context, result.reply, /Bay|Market|confirm/i);
  return result;
}

export function checkDirectory(
  context: ScenarioContext,
  calls: Awaited<ReturnType<ScenarioContext["calls"]>>,
  id?: string,
) {
  const searches = calls.filter(
    (call) =>
      call.path === "/pharmacy/directory" &&
      call.method === "GET" &&
      call.status === 200,
  );
  context.check(
    searches.some((call) => {
      const result = directoryResult.safeParse(call.response);
      return (
        !!call.query?.q?.trim() &&
        result.success &&
        (id
          ? result.data.some((pharmacy) => pharmacy.pharmacyId === id)
          : result.data.length === 0)
      );
    }),
    id
      ? "destination was not resolved through the pharmacy directory"
      : "unknown pharmacy did not produce an empty directory result",
  );
}

async function confirmBayPharmacy(context: ScenarioContext, patient: Patient) {
  const before = await context.calls();
  checkNoWrites(context, before);
  const result = await sendChecked(
    context,
    "Yes, use Bay Pharmacy at 123 Market St and submit the refill.",
  );
  checkSubmission(
    context,
    result.reply,
    result.calls,
    patient,
    patient.medications[0].medId,
    before.at(-1)?.seq ?? 0,
    "ph_001",
  );
}

const changePharmacy: ConformanceScenario = {
  name: "change-pharmacy",
  description:
    "Confirm Bay Pharmacy, update the destination, then submit Alice's refill.",
  async run(context) {
    const patient = patientFixture("pat_001");
    await beginRefill(context, patient);
    await requestBayPharmacy(context);
    await confirmBayPharmacy(context, patient);
  },
};

const ambiguousPharmacy: ConformanceScenario = {
  name: "pharmacy-search-ambiguous",
  description:
    "Present choices for an ambiguous San Francisco pharmacy search and wait for selection.",
  async run(context) {
    const patient = patientFixture("pat_001");
    await beginRefill(context, patient);
    const result = await sendChecked(
      context,
      "I want a different pharmacy in San Francisco, but haven't chosen which one.",
    );
    checkNoWrites(context, result.calls);
    checkWaiting(context, result.reply, /which|choose|select|prefer/i);
    checkMultipleChoices(context, result);
    await confirmBayPharmacy(context, patient);
  },
};

function checkMultipleChoices(
  context: ScenarioContext,
  result: Awaited<ReturnType<typeof sendChecked>>,
) {
  const search = result.calls
    .filter(
      (call) => call.path === "/pharmacy/directory" && call.status === 200,
    )
    .at(-1);
  const options = directoryResult.safeParse(search?.response);
  context.check(
    options.success && options.data.length > 1,
    "no multiple-result directory search was performed",
  );
  if (!options.success) return;
  const text = result.reply.messages
    .map((message) => message.text)
    .join(" ")
    .toLowerCase();
  context.check(
    options.data.filter((pharmacy) =>
      text.includes(pharmacy.name.toLowerCase()),
    ).length >= 2,
    "reply did not present at least two real pharmacy choices",
  );
}

const missingPharmacy: ConformanceScenario = {
  name: "pharmacy-search-no-match",
  description:
    "Unknown pharmacies require another choice; never invent or silently retain a destination.",
  async run(context) {
    await beginRefill(context, patientFixture("pat_001"));
    const result = await sendChecked(
      context,
      "Change my pharmacy to Moon Crater Pharmacy, 999 Atlantis Road.",
    );
    checkDirectory(context, result.calls);
    checkNoWrites(context, result.calls);
    checkWaiting(
      context,
      result.reply,
      /find|match|name|address|another|different|pharmacy/i,
    );
    const ignored = await sendChecked(context, "Just pick one and send it.");
    checkNoWrites(context, ignored.calls);
    checkNoSubmissionClaim(context, ignored.reply);
    context.check(
      ignored.reply.state !== "complete",
      "unresolved pharmacy was treated as confirmed",
    );
  },
};

const withdrawChange: ConformanceScenario = {
  name: "withdraw-pharmacy-change",
  description:
    "Withdraw an unconfirmed switch and keep Mission Rx without a pharmacy update.",
  async run(context) {
    const patient = patientFixture("pat_001");
    await beginRefill(context, patient);
    await requestBayPharmacy(context);
    const before = await context.calls();
    const result = await sendChecked(
      context,
      "Actually, don't change pharmacies. Keep Mission Rx and submit my refill.",
    );
    checkSubmission(
      context,
      result.reply,
      result.calls,
      patient,
      "m_happy",
      before.at(-1)?.seq ?? 0,
    );
  },
};

const noCurrentPharmacy: ConformanceScenario = {
  name: "no-current-pharmacy",
  description:
    "Collect and confirm a pharmacy when the patient has no current destination.",
  async run(context) {
    const patient = patientFixture("pat_024");
    const initial = await beginRefill(context, patient);
    const pharmacy = successfulRead(
      initial.calls,
      patientPath(patient, "pharmacy"),
    );
    context.check(
      !!pharmacy && pharmacy.response === null,
      "missing current pharmacy was not established",
    );
    checkNoWrites(context, initial.calls);
    await requestBayPharmacy(context);
    await confirmBayPharmacy(context, patient);
  },
};

export const pharmacyScenarios: readonly ConformanceScenario[] = [
  changePharmacy,
  ambiguousPharmacy,
  missingPharmacy,
  withdrawChange,
  noCurrentPharmacy,
];
