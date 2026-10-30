import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { createMockServer } from "./server.js";
import type { Dataset } from "./types.js";

const fixture = (): Dataset =>
  JSON.parse(readFileSync(new URL("./dataset.json", import.meta.url), "utf8"));

async function startMock(t: TestContext, dataset = fixture(), now?: string) {
  const server = createMockServer({
    dataset,
    now,
    ehrApiKey: "test-ehr",
    pharmacyApiKey: "test-pharmacy",
  });
  closeAfterTest(t, server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return createMockClient(`http://127.0.0.1:${address.port}`);
}

function closeAfterTest(t: TestContext, server: Server) {
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
}

function createMockClient(base: string) {
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    token = "test-ehr",
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const refill = (patientId: string, medId: string) =>
    request(`/ehr/patients/${patientId}/refills`, "POST", { medId });
  return { request, refill };
}

test("reset restores pharmacies, refill counts, IDs, and call-log state without modifying fixtures", async (t) => {
  const dataset = fixture();
  const original = structuredClone(dataset);
  const { request, refill } = await startMock(t, dataset);
  await request("/ehr/patients/pat_001/pharmacy", "PUT", {
    pharmacyId: "ph_001",
  });
  assert.deepEqual((await request("/ehr/patients/pat_001/pharmacy")).body, {
    pharmacyId: "ph_001",
    name: "Bay Pharmacy",
  });
  assert.deepEqual(await refill("pat_001", "m_happy"), {
    status: 200,
    body: { refillId: "rf_1", status: "submitted" },
  });
  const medications = (await request("/ehr/patients/pat_001/medications")).body;
  assert.equal(medications[0].refillsRemaining, 2);
  assert.equal(medications[0].lastFilledDate, "2026-08-12");
  assert.deepEqual(dataset, original);

  assert.deepEqual(await request("/__reset", "POST"), {
    status: 200,
    body: { ok: true },
  });
  assert.deepEqual((await request("/__calls")).body, []);
  assert.deepEqual((await request("/ehr/patients/pat_001/pharmacy")).body, {
    pharmacyId: "ph_002",
    name: "Mission Rx",
  });
  assert.deepEqual(
    (await request("/ehr/patients/pat_001/medications")).body,
    original.patients[0].medications,
  );
  assert.equal((await request("/__calls")).body[0].seq, 1);
  assert.equal((await refill("pat_001", "m_happy")).body.refillId, "rf_1");
});

test("mock blocks each clinical restriction and records rejected attempts without consuming refills", async (t) => {
  const dataset = fixture();
  const expired = dataset.patients.find(
    (patient) => patient.patientId === "pat_003",
  )!;
  // Isolate expiration from the separate no-refills restriction in the original fixture.
  expired.medications[0].refillsRemaining = 1;
  const { request, refill } = await startMock(t, dataset);
  for (const [patientId, medId, error] of [
    ["pat_002", "m_cii", "schedule_ii"],
    ["pat_003", "m_exp", "prescription_expired"],
    ["pat_004", "m_early", "controlled_refill_too_early"],
    ["pat_006", "m_warf_stale", "recent_lab_required"],
  ]) {
    assert.deepEqual(await refill(patientId, medId), {
      status: 409,
      body: { error },
    });
    const original = dataset.patients.find(
      (patient) => patient.patientId === patientId,
    )!;
    assert.deepEqual(
      (await request(`/ehr/patients/${patientId}/medications`)).body,
      original.medications,
    );
  }
  const recorded = (await request("/__calls")).body;
  assert.equal(
    recorded.filter((call: { method: string }) => call.method === "POST")
      .length,
    4,
  );
});

test("eligible non-controlled, controlled, and lab-dependent refills consume one remaining refill", async (t) => {
  const dataset = fixture();
  const { request, refill } = await startMock(t, dataset);
  for (const [patientId, medId] of [
    ["pat_001", "m_happy"],
    ["pat_004", "m_ok"],
    ["pat_005", "m_ctrl_ok"],
    ["pat_007", "m_warf_ok"],
  ]) {
    assert.equal((await refill(patientId, medId)).status, 200);
    const original = dataset.patients.find(
      (patient) => patient.patientId === patientId,
    )!.medications;
    const expected = original.map((medication) => ({
      ...medication,
      refillsRemaining:
        medication.refillsRemaining - Number(medication.medId === medId),
    }));
    assert.deepEqual(
      (await request(`/ehr/patients/${patientId}/medications`)).body,
      expected,
    );
  }
});

test("exhausted refills and unknown medications never produce successful submissions", async (t) => {
  const { request, refill } = await startMock(t);
  for (let i = 1; i <= 3; i++) {
    assert.deepEqual(await refill("pat_001", "m_happy"), {
      status: 200,
      body: { refillId: `rf_${i}`, status: "submitted" },
    });
  }
  assert.deepEqual(await refill("pat_001", "m_happy"), {
    status: 409,
    body: { error: "no_refills" },
  });
  assert.equal(
    (await request("/ehr/patients/pat_001/medications")).body[0]
      .refillsRemaining,
    0,
  );
  assert.equal((await refill("pat_001", "m_ctrl_ok")).status, 404);
  assert.equal((await refill("unknown", "m_happy")).status, 404);
  assert.equal((await refill("pat_005", "m_ctrl_ok")).body.refillId, "rf_4");
});

test("controlled window, expiration, and lab cutoffs use inclusive UTC calendar dates and simulated time", async (t) => {
  const { refill } = await startMock(t, fixture(), "2026-09-25T23:59:59Z");
  assert.equal((await refill("pat_004", "m_early")).status, 200); // exactly two days before Sept 27
  const beforeWindow = await startMock(t, fixture(), "2026-09-24T23:59:59Z");
  assert.equal((await beforeWindow.refill("pat_004", "m_early")).status, 409);

  for (const [now, expected] of [
    ["2027-02-28T23:59:59Z", 200],
    ["2027-03-01T00:00:00Z", 409],
  ] as const) {
    const mock = await startMock(t, fixture(), now);
    assert.equal((await mock.refill("pat_001", "m_happy")).status, expected);
  }
  for (const [now, expected] of [
    ["2026-09-21T23:59:59Z", 200], // 30-day-old INR
    ["2026-09-22T00:00:00Z", 409], // 31-day-old INR
    ["2026-08-21T00:00:00Z", 409], // future INR
  ] as const) {
    const mock = await startMock(t, fixture(), now);
    assert.equal((await mock.refill("pat_007", "m_warf_ok")).status, expected);
  }
});

test("missing or wrong-type labs cannot satisfy a required lab", async (t) => {
  for (const labs of [
    [],
    [{ type: "CBC", value: "normal", takenDate: "2026-08-22" }],
  ]) {
    const dataset = fixture();
    const patient = dataset.patients.find(
      (patient) => patient.patientId === "pat_007",
    )!;
    patient.labs.splice(0, patient.labs.length, ...labs);
    const { refill } = await startMock(t, dataset);
    assert.deepEqual(await refill("pat_007", "m_warf_ok"), {
      status: 409,
      body: { error: "recent_lab_required" },
    });
  }
});

test("mock matching preserves factor rules and only returns an ID for a unique patient", async (t) => {
  const { request } = await startMock(t);
  const match = (factors: object) =>
    request("/ehr/patients:match", "POST", { factors });
  assert.deepEqual(
    (
      await match({
        firstName: "ALICE",
        lastName: "nguyen",
        dob: "1988-03-12",
        zip: "94107",
      })
    ).body,
    { count: 1, patientId: "pat_001" },
  );
  const ambiguous = {
    firstName: "Emma",
    lastName: "Nguyen",
    dob: "1957-07-04",
    zip: "94112",
  };
  assert.deepEqual((await match(ambiguous)).body, {
    count: 2,
    patientId: null,
  });
  assert.deepEqual((await match({ ...ambiguous, phoneLast4: "6980" })).body, {
    count: 1,
    patientId: "pat_009",
  });
  assert.deepEqual((await match({ ...ambiguous, phoneLast4: "0000" })).body, {
    count: 0,
    patientId: null,
  });
  assert.deepEqual((await match({ unknownFactor: "x" })).body, {
    count: 0,
    patientId: null,
  });
  assert.deepEqual((await request("/ehr/patients/pat_001")).body, {
    patientId: "pat_001",
    firstName: "Alice",
    lastName: "Nguyen",
    dob: "1988-03-12",
    phone: "415-555-1234",
    zip: "94107",
  });
});

test("mock service authorization and pharmacy search remain independent of patient matching", async (t) => {
  const { request } = await startMock(t);
  assert.equal(
    (await request("/ehr/time", "GET", undefined, "wrong")).status,
    401,
  );
  assert.equal((await request("/pharmacy/directory?q=bay")).status, 401);
  assert.deepEqual((await request("/__calls")).body, []);
  const directory = await request(
    "/pharmacy/directory?q=MARKET",
    "GET",
    undefined,
    "test-pharmacy",
  );
  assert.deepEqual(directory.body, [
    {
      pharmacyId: "ph_001",
      name: "Bay Pharmacy",
      address: "123 Market St, San Francisco, CA 94103",
    },
  ]);
  assert.deepEqual(
    (
      await request(
        "/pharmacy/directory?q=unknown",
        "GET",
        undefined,
        "test-pharmacy",
      )
    ).body,
    [],
  );
  assert.equal(
    (
      await request("/ehr/patients/pat_001/pharmacy", "PUT", {
        pharmacyId: "unknown",
      })
    ).status,
    404,
  );
  assert.equal(
    (await request("/ehr/patients/pat_001/pharmacy")).body.pharmacyId,
    "ph_002",
  );
});

test("mock lab filtering and unknown routes preserve their HTTP responses", async (t) => {
  const { request } = await startMock(t);
  assert.deepEqual(
    (await request("/ehr/patients/pat_007/labs?type=inr")).body,
    [{ type: "INR", value: "2.6", takenDate: "2026-08-22" }],
  );
  assert.deepEqual(
    (await request("/ehr/patients/pat_007/labs?type=CBC")).body,
    [],
  );
  for (const path of [
    "/unknown",
    "/ehr/patients/pat_001/unknown",
    "/ehr/patients/pat_001/medications/extra",
  ]) {
    assert.equal((await request(path)).status, 404);
  }
});
