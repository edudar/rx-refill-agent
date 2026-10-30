import { z } from "zod";
import type { ConformanceScenario, RecordedCall } from "../contracts.js";

const refillBodySchema = z.object({ medId: z.string().min(1) });

export const happyPath: ConformanceScenario = {
  name: "happy-path",
  description:
    "Authenticate Alice, retain her pharmacy, and submit her lisinopril refill.",
  async run({ send, calls, check }) {
    const script = [
      "I'd like to refill my Lisinopril.",
      "Alice Nguyen, DOB 1988-03-12, ZIP 94107.",
      "Yes, keep my pharmacy.",
    ];
    let lastState = "in_progress";
    for (const text of script) lastState = (await send(text)).state;

    const recorded = await calls();
    const match = recorded.find(
      (call) => call.path === "/ehr/patients:match" && call.method === "POST",
    );
    const meds = recorded.find(
      (call) =>
        /^\/ehr\/patients\/[^/]+\/medications$/.test(call.path) &&
        call.method === "GET",
    );
    const refill = recorded.find(
      (call) =>
        /^\/ehr\/patients\/[^/]+\/refills$/.test(call.path) &&
        call.method === "POST",
    );
    const patientId = (call: RecordedCall) => call.path.split("/")[3];

    check(
      lastState === "complete",
      `expected final state "complete", got "${lastState}"`,
    );
    check(
      !!match,
      "agent never called POST /ehr/patients:match (identity verification)",
    );
    check(!!meds, "agent never fetched the patient's medications");
    check(
      !!refill,
      "agent never submitted a refill (POST /ehr/patients/{id}/refills)",
    );
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
  },
};
