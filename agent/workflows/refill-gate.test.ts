import assert from "node:assert/strict";
import test from "node:test";
import type {
  CurrentPharmacy,
  EhrClient,
  LabResult,
  Medication,
} from "../contracts/ehr.js";
import {
  ServiceRequestError,
  type ServiceFailureKind,
} from "../contracts/service-errors.js";
import type { VerifiedConversation } from "../domain/conversation.js";
import { createRefillGate, type RefillOrder } from "./refill-gate.js";

const lisinopril: Medication = {
  medId: "m-1",
  name: "Lisinopril 10mg",
  isControlled: false,
  schedule: null,
  lastFilledDate: "2026-08-25",
  daysSupply: 30,
  refillsRemaining: 2,
  rxExpirationDate: "2027-01-01",
  requiresRecentLab: null,
};

function verified(patientId = "p-1"): VerifiedConversation {
  return {
    phase: "verified",
    patient: {
      patientId,
      firstName: "Alice",
      lastName: "Nguyen",
      dob: "1988-03-12",
      phone: "415-555-1234",
      zip: "94107",
    },
    history: [],
    lastPrompt: "",
    createdAt: 0,
    touchedAt: 0,
  };
}

const order: RefillOrder = {
  patientId: "p-1",
  medId: "m-1",
  pharmacyId: "ph-1",
};

// An in-memory EHR whose failures are scripted per operation.
function fakeEhr(
  options: {
    medications?: Medication[];
    labs?: LabResult[];
    pharmacy?: CurrentPharmacy;
    fail?: Partial<Record<keyof EhrClient, ServiceFailureKind | Error>>;
  } = {},
) {
  const calls: string[] = [];
  const state = {
    medications: options.medications ?? [lisinopril],
    pharmacy: options.pharmacy ?? { pharmacyId: "ph-1", name: "Mission Rx" },
    fail: options.fail ?? {},
    refills: 0,
  };
  const operation =
    <A extends unknown[], R>(name: keyof EhrClient, run: (...args: A) => R) =>
    async (...args: A): Promise<R> => {
      calls.push(name);
      const failure = state.fail[name];
      if (failure instanceof Error) throw failure;
      if (failure) throw new ServiceRequestError(failure);
      return run(...args);
    };
  const ehr: EhrClient = {
    match: operation("match", () => ({ count: 0, patientId: null })),
    getPatient: operation("getPatient", () => {
      throw new Error("not used");
    }),
    getTime: operation("getTime", () => "2026-09-01T12:00:00Z"),
    getMedications: operation("getMedications", () => state.medications),
    getLabs: operation("getLabs", (_patientId: string, type: string) => {
      calls.push(`labs:${type}`);
      return options.labs ?? [];
    }),
    getPharmacy: operation("getPharmacy", () => state.pharmacy),
    setPharmacy: operation(
      "setPharmacy",
      (_patientId: string, pharmacyId: string) => {
        state.pharmacy = { pharmacyId, name: pharmacyId };
      },
    ),
    submitRefill: operation("submitRefill", () => ({
      refillId: `rf_${++state.refills}`,
      status: "submitted" as const,
    })),
  };
  return { ehr, calls, state };
}

const writes = (calls: string[]) =>
  calls.filter((call) => call === "setPharmacy" || call === "submitRefill");

test("an eligible refill re-reads the clock and record, then submits once", async () => {
  const f = fakeEhr();
  const gate = createRefillGate({ ehr: f.ehr });
  assert.deepEqual(await gate.submit(verified(), order), {
    status: "submitted",
    refillId: "rf_1",
    pharmacyChanged: false,
  });
  assert.deepEqual(f.calls, [
    "getTime",
    "getMedications",
    "getPharmacy",
    "submitRefill",
  ]);
  assert.deepEqual(await gate.submit(verified(), order), {
    status: "already_submitted",
    refillId: "rf_1",
  });
  assert.equal(writes(f.calls).length, 1);
});

test("a confirmed new destination is set before the refill is submitted", async () => {
  const f = fakeEhr();
  const outcome = await createRefillGate({ ehr: f.ehr }).submit(verified(), {
    ...order,
    pharmacyId: "ph-2",
  });
  assert.deepEqual(outcome, {
    status: "submitted",
    refillId: "rf_1",
    pharmacyChanged: true,
  });
  assert.deepEqual(writes(f.calls), ["setPharmacy", "submitRefill"]);
  assert.equal(f.state.pharmacy?.pharmacyId, "ph-2");
});

test("ineligible refills never reach pharmacy or refill writes", async () => {
  for (const [medication, labs] of [
    [{ ...lisinopril, schedule: "CII", isControlled: true }, []],
    [{ ...lisinopril, refillsRemaining: 0 }, []],
    [
      { ...lisinopril, requiresRecentLab: { type: "INR", withinDays: 30 } },
      [{ type: "INR", value: "2.0", takenDate: "2026-07-01" }],
    ],
  ] as [Medication, LabResult[]][]) {
    const f = fakeEhr({ medications: [medication], labs, pharmacy: null });
    const outcome = await createRefillGate({ ehr: f.ehr }).submit(verified(), {
      ...order,
      pharmacyId: "ph-2",
    });
    assert.equal(outcome.status, "ineligible");
    assert.deepEqual(writes(f.calls), []);
    assert.ok(!f.calls.includes("getPharmacy"));
  }
});

test("required labs are fetched by type and evaluated at submission time", async () => {
  const f = fakeEhr({
    medications: [
      { ...lisinopril, requiresRecentLab: { type: "INR", withinDays: 30 } },
    ],
    labs: [{ type: "INR", value: "2.0", takenDate: "2026-08-20" }],
  });
  const gate = createRefillGate({ ehr: f.ehr });
  assert.equal((await gate.submit(verified(), order)).status, "submitted");
  assert.ok(f.calls.includes("labs:INR"));
});

test("a record that changed since the proposal is evaluated as it is now", async () => {
  const f = fakeEhr();
  f.state.medications = [{ ...lisinopril, refillsRemaining: 0 }];
  const outcome = await createRefillGate({ ehr: f.ehr }).submit(
    verified(),
    order,
  );
  assert.equal(outcome.status, "ineligible");
  assert.deepEqual(writes(f.calls), []);
});

test("orders for another patient or an unknown medication write nothing", async () => {
  const f = fakeEhr();
  const gate = createRefillGate({ ehr: f.ehr });
  assert.deepEqual(await gate.submit(verified("p-2"), order), {
    status: "not_authorized",
  });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await gate.submit(verified(), { ...order, medId: "m-9" }), {
    status: "medication_not_found",
  });
  assert.deepEqual(writes(f.calls), []);
});

test("read outages and failed destination updates write no refill and allow a retry", async () => {
  for (const failing of ["getTime", "getMedications", "getPharmacy"] as const) {
    const f = fakeEhr({ fail: { [failing]: "unavailable" } });
    const gate = createRefillGate({ ehr: f.ehr });
    assert.deepEqual(await gate.submit(verified(), order), {
      status: "unavailable",
    });
    assert.deepEqual(writes(f.calls), []);
    f.state.fail = {};
    assert.equal((await gate.submit(verified(), order)).status, "submitted");
  }
  const f = fakeEhr({ fail: { setPharmacy: "no_response" } });
  const gate = createRefillGate({ ehr: f.ehr });
  const changed = { ...order, pharmacyId: "ph-2" };
  assert.deepEqual(await gate.submit(verified(), changed), {
    status: "pharmacy_update_failed",
  });
  assert.ok(!f.calls.includes("submitRefill"));
  f.state.fail = {};
  assert.equal((await gate.submit(verified(), changed)).status, "submitted");
});

test("a refused submission is reported and may be retried by the patient", async () => {
  const f = fakeEhr({ fail: { submitRefill: "rejected" } });
  const gate = createRefillGate({ ehr: f.ehr });
  assert.deepEqual(await gate.submit(verified(), order), {
    status: "submission_rejected",
    pharmacyChanged: false,
  });
  f.state.fail = {};
  assert.equal((await gate.submit(verified(), order)).status, "submitted");
  assert.equal(f.calls.filter((call) => call === "submitRefill").length, 2);
});

test("a submission with an unknown outcome is never sent again", async () => {
  for (const failure of [
    "unavailable",
    "no_response",
    "invalid_response",
    new Error("unexpected"),
  ] as const) {
    const f = fakeEhr({ fail: { submitRefill: failure } });
    const gate = createRefillGate({ ehr: f.ehr });
    const first = await gate.submit(verified(), order);
    assert.deepEqual(first, {
      status: "submission_unknown",
      pharmacyChanged: false,
    });
    f.state.fail = {};
    // A later turn or another conversation for the same patient stays blocked.
    assert.equal(
      (await gate.submit(verified(), order)).status,
      "submission_unknown",
    );
    assert.equal(f.calls.filter((call) => call === "submitRefill").length, 1);
  }
});

test("concurrent conversations for one refill submit it only once", async () => {
  const f = fakeEhr();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getTime = f.ehr.getTime;
  f.ehr.getTime = async () => {
    await gate;
    return getTime();
  };
  const refillGate = createRefillGate({ ehr: f.ehr });
  const first = refillGate.submit(verified(), order);
  const second = await refillGate.submit(verified(), order);
  release();
  assert.deepEqual(second, { status: "submission_in_progress" });
  assert.equal((await first).status, "submitted");
  assert.equal(f.calls.filter((call) => call === "submitRefill").length, 1);
});

test("the submission ledger forgets refills after 24 hours", async () => {
  let clock = 0;
  const f = fakeEhr();
  const gate = createRefillGate({ ehr: f.ehr, now: () => clock });
  await gate.submit(verified(), order);
  clock = 24 * 60 * 60 * 1_000 - 1;
  assert.equal(
    (await gate.submit(verified(), order)).status,
    "already_submitted",
  );
  clock++;
  assert.equal((await gate.submit(verified(), order)).status, "submitted");
});
