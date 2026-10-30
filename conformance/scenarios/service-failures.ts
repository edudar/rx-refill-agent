import type { ConformanceScenario, ScenarioContext } from "../contracts.js";
import { patientFixture } from "../fixtures.js";
import { beginRefill, sendChecked } from "../dialogue.js";
import {
  checkNoSubmissionClaim,
  checkNoWrites,
  checkText,
  patientPath,
  pharmacyWrites,
  refillCalls,
} from "../assertions.js";
import { requestBayPharmacy } from "./pharmacies.js";

const alice = patientFixture("pat_001");

const lookupFailure: ConformanceScenario = {
  name: "ehr-lookup-outage",
  description:
    "A matched-record outage must not authenticate the patient or trigger refill processing.",
  async run(context) {
    await context.fault("GET", patientPath(alice));
    const result = await beginRefill(context, alice);
    context.check(
      result.calls.some(
        (call) => call.path === patientPath(alice) && call.status === 503,
      ),
      "record lookup did not encounter the injected outage",
    );
    checkNoWrites(context, result.calls);
    checkFailureReply(context, result.reply);
    context.check(
      !/identity (?:is|has been) verified|(?:i've|i have) verified your identity/i.test(
        result.reply.messages.map((message) => message.text).join(" "),
      ),
      "lookup outage was presented as successful verification",
    );
    context.check(
      !result.calls.some((call) =>
        /\/(?:medications|labs|pharmacy)$/.test(call.path),
      ),
      "continued to clinical processing after failed record verification",
    );
  },
};

const pharmacyFailure: ConformanceScenario = {
  name: "pharmacy-update-failure",
  description:
    "A failed pharmacy update prevents submission and must not be reported as a completed switch.",
  async run(context) {
    await context.fault("PUT", patientPath(alice, "pharmacy"));
    await beginRefill(context, alice);
    await requestBayPharmacy(context);
    const result = await sendChecked(
      context,
      "Yes, use Bay Pharmacy and submit the refill.",
    );
    const writes = pharmacyWrites(result.calls);
    context.check(
      writes.length >= 1 && writes.every((call) => call.status === 503),
      "pharmacy update did not encounter the injected outage",
    );
    context.check(
      refillCalls(result.calls).length === 0,
      "submitted despite a failed destination update",
    );
    checkFailureReply(context, result.reply);
    checkText(
      context,
      result.reply,
      /pharmacy|change|update|switch/i,
      "failed pharmacy change was not identified",
    );
    context.check(
      !/pharmacy (?:has been |was |is )?(?:changed|updated|switched)/i.test(
        result.reply.messages.map((message) => message.text).join(" "),
      ),
      "claimed the failed pharmacy switch succeeded",
    );
  },
};

const submissionFailure: ConformanceScenario = {
  name: "refill-submission-failure",
  description:
    "A failed non-idempotent submission is not reported as complete or automatically repeated.",
  async run(context) {
    await context.fault("POST", patientPath(alice, "refills"));
    const initial = await beginRefill(context, alice);
    checkNoWrites(context, initial.calls);
    const result = await sendChecked(
      context,
      "Yes, keep Mission Rx and submit the refill.",
    );
    const attempts = refillCalls(result.calls);
    context.check(
      attempts.length === 1 && attempts[0].status === 503,
      "expected one failed submission without an automatic retry",
    );
    checkFailureReply(context, result.reply);
  },
};

function checkFailureReply(
  context: ScenarioContext,
  reply: Awaited<ReturnType<ScenarioContext["send"]>>,
) {
  context.check(
    reply.state !== "complete",
    "service failure was reported as a completed request",
  );
  checkNoSubmissionClaim(context, reply);
  checkText(
    context,
    reply,
    /unavailable|trouble|unable|couldn't|cannot|failed|try again|care team/i,
    "service failure was not honestly explained",
  );
}

export const serviceFailureScenarios: readonly ConformanceScenario[] = [
  lookupFailure,
  pharmacyFailure,
  submissionFailure,
];
