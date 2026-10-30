import { z } from "zod";
import type {
  ConformanceScenario,
  RecordedCall,
  ScenarioContext,
} from "../contracts.js";

const refillBodySchema = z.object({ medId: z.string().min(1) });
const script = [
  "I'd like to refill my Lisinopril.",
  "Alice Nguyen, DOB 1988-03-12, ZIP 94107.",
  "Yes, keep my pharmacy.",
];

export const happyPath: ConformanceScenario = {
  name: "happy-path",
  description:
    "Authenticate Alice, retain her pharmacy, and submit her lisinopril refill.",
  async run({ send, calls, check }) {
    let lastState = "in_progress";
    for (const text of script) lastState = (await send(text)).state;
    check(
      lastState === "complete",
      `expected final state "complete", got "${lastState}"`,
    );
    const recorded = await calls();
    const workflowCalls = findWorkflowCalls(recorded);
    checkRequiredCalls(workflowCalls, check);
    checkRefillConsistency(workflowCalls, check);
  },
};

function findWorkflowCalls(recorded: RecordedCall[]) {
  return {
    match: recorded.find(
      (call) => call.path === "/ehr/patients:match" && call.method === "POST",
    ),
    meds: recorded.find(
      (call) =>
        /^\/ehr\/patients\/[^/]+\/medications$/.test(call.path) &&
        call.method === "GET",
    ),
    refill: recorded.find(
      (call) =>
        /^\/ehr\/patients\/[^/]+\/refills$/.test(call.path) &&
        call.method === "POST",
    ),
  };
}

type WorkflowCalls = ReturnType<typeof findWorkflowCalls>;

function checkRequiredCalls(
  { match, meds, refill }: WorkflowCalls,
  check: ScenarioContext["check"],
) {
  check(
    !!match,
    "agent never called POST /ehr/patients:match (identity verification)",
  );
  check(!!meds, "agent never fetched the patient's medications");
  check(
    !!refill,
    "agent never submitted a refill (POST /ehr/patients/{id}/refills)",
  );
}

function checkRefillConsistency(
  { match, meds, refill }: WorkflowCalls,
  check: ScenarioContext["check"],
) {
  if (match && refill)
    check(
      refill.seq > match.seq,
      "agent submitted a refill BEFORE verifying identity (:match)",
    );
  if (meds && refill)
    check(
      patientId(meds) === patientId(refill),
      "agent refilled a different patient than it looked up",
    );
  if (refill)
    check(
      refillBodySchema.safeParse(refill.body).success,
      "refill call had no valid medId in body",
    );
}

function patientId(call: RecordedCall) {
  return call.path.split("/")[3];
}
