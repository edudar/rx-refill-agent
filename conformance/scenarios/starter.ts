import type { ConformanceScenario, RecordedCall } from "../contracts.js";

// The assessment's original conformance script and checks (verbatim copy in
// conformance/starter/run.ts). It needs only the starter mock's /__reset and /__calls and
// uses no fixture data, so it runs against the grader's mock and dataset.
export const starterScript = [
  "I'd like to refill my Lisinopril.",
  "Alice Nguyen, DOB 1988-03-12, phone ending 1234, zip 94107.",
  "Yes, keep my pharmacy.",
] as const;

export const starterHappyPath: ConformanceScenario = {
  name: "starter-happy-path",
  description:
    "The original assessment script: refill Alice's Lisinopril, keep her pharmacy, finish complete.",
  async run(context) {
    let lastState = "in_progress";
    for (const text of starterScript)
      lastState = (await context.send(text)).state;
    checkStarterCalls(context.check, lastState, await context.calls());
  },
};

function checkStarterCalls(
  ok: (condition: boolean, message: string) => void,
  lastState: string,
  calls: RecordedCall[],
) {
  const match = calls.find(
    (c) => c.path === "/ehr/patients:match" && c.method === "POST",
  );
  const meds = calls.find(
    (c) =>
      /^\/ehr\/patients\/[^/]+\/medications$/.test(c.path) &&
      c.method === "GET",
  );
  const refill = calls.find(
    (c) =>
      /^\/ehr\/patients\/[^/]+\/refills$/.test(c.path) && c.method === "POST",
  );
  const pid = (c?: RecordedCall) => c?.path.split("/")[3];
  const medId = (refill?.body as { medId?: unknown } | undefined)?.medId;

  ok(
    lastState === "complete",
    `expected final state "complete", got "${lastState}"`,
  );
  ok(
    !!match,
    "agent never called POST /ehr/patients:match (identity verification)",
  );
  ok(!!meds, "agent never fetched the patient's medications");
  ok(
    !!refill,
    "agent never submitted a refill (POST /ehr/patients/{id}/refills)",
  );
  if (match && refill)
    ok(
      refill.seq > match.seq,
      "agent submitted a refill BEFORE verifying identity (:match)",
    );
  if (meds && refill)
    ok(
      pid(meds) === pid(refill),
      "agent refilled a different patient than it looked up",
    );
  if (refill) ok(!!medId, "refill call had no medId in body");
}
