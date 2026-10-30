import assert from "node:assert/strict";
import { once } from "node:events";
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
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        authorization: "Bearer test-ehr",
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
