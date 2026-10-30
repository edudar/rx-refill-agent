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

test("refills are accepted like the starter mock: no clinical enforcement or refill consumption", async (t) => {
  const dataset = fixture();
  const original = structuredClone(dataset);
  const { request, refill } = await startMock(t, dataset);
  const restricted = [
    ["pat_002", "m_cii"],
    ["pat_003", "m_exp"],
    ["pat_004", "m_early"],
    ["pat_006", "m_warf_stale"],
  ];
  for (const [index, [patientId, medId]] of restricted.entries()) {
    assert.deepEqual(await refill(patientId, medId), {
      status: 200,
      body: { refillId: `rf_${index + 1}`, status: "submitted" },
    });
  }
  for (const patient of original.patients)
    assert.deepEqual(
      (await request(`/ehr/patients/${patient.patientId}/medications`)).body,
      patient.medications,
    );
  assert.deepEqual(dataset, original);
  assert.deepEqual(await refill("pat_001", "m_ctrl_ok"), {
    status: 404,
    body: { error: "medication not found" },
  });
  assert.equal((await refill("unknown", "m_happy")).status, 404);
  assert.equal(
    (await request("/ehr/patients/pat_001/refills", "POST", {})).status,
    400,
  );
});

test("POST /__reset keeps starter semantics: it clears calls but not patient state", async (t) => {
  const { request, refill } = await startMock(t);
  await request("/ehr/patients/pat_001/pharmacy", "PUT", {
    pharmacyId: "ph_001",
  });
  await refill("pat_001", "m_happy");
  assert.deepEqual(await request("/__reset", "POST"), {
    status: 200,
    body: { ok: true },
  });
  assert.deepEqual((await request("/__calls")).body, []);
  assert.deepEqual((await request("/ehr/patients/pat_001/pharmacy")).body, {
    pharmacyId: "ph_001",
    name: "Bay Pharmacy",
  });
  assert.equal((await request("/__calls")).body[0].seq, 1);
  assert.equal((await refill("pat_001", "m_happy")).body.refillId, "rf_2");
});

test("harness restore returns pharmacies, refill IDs, faults, and calls to startup state", async (t) => {
  const dataset = fixture();
  const original = structuredClone(dataset);
  const { request, refill } = await startMock(t, dataset);
  await request("/ehr/patients/pat_001/pharmacy", "PUT", {
    pharmacyId: "ph_001",
  });
  await refill("pat_001", "m_happy");
  await request("/__harness/faults", "POST", {
    method: "GET",
    path: "/ehr/time",
    times: 5,
  });
  assert.deepEqual(await request("/__harness/restore", "POST"), {
    status: 200,
    body: { ok: true },
  });
  assert.deepEqual((await request("/__calls")).body, []);
  assert.equal((await request("/ehr/time")).status, 200);
  assert.deepEqual((await request("/ehr/patients/pat_001/pharmacy")).body, {
    pharmacyId: "ph_002",
    name: "Mission Rx",
  });
  assert.equal((await refill("pat_001", "m_happy")).body.refillId, "rf_1");
  assert.deepEqual(dataset, original);
});

test("harness discovery reports capabilities and the served fixture; removed controls are not routed", async (t) => {
  const { request } = await startMock(t, fixture(), "2026-10-01T00:00:00Z");
  const harness = await request("/__harness");
  assert.deepEqual(harness.body.capabilities, [
    "restore",
    "faults",
    "call-outcomes",
  ]);
  assert.equal(harness.body.now, "2026-10-01T00:00:00Z");
  assert.equal(harness.body.patientIds.length, 12);
  assert.equal((await request("/ehr/time")).body.now, "2026-10-01T00:00:00Z");
  for (const path of ["/__fixture", "/__faults"])
    assert.equal((await request(path, "POST", {})).status, 404);
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

test("pharmacy search and pharmacy updates validate their inputs", async (t) => {
  const { request } = await startMock(t);
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

test("unauthorized requests are rejected before recording, like the starter mock", async (t) => {
  const { request } = await startMock(t);
  assert.equal(
    (await request("/ehr/time", "GET", undefined, "wrong")).status,
    401,
  );
  assert.equal((await request("/pharmacy/directory?q=bay")).status, 401);
  assert.deepEqual((await request("/__calls")).body, []);
});

test("call records add response outcomes as response snapshots", async (t) => {
  const { request, refill } = await startMock(t);
  await request("/ehr/patients:match", "POST", {
    factors: {
      firstName: "Alice",
      lastName: "Nguyen",
      dob: "1988-03-12",
      zip: "94107",
    },
  });
  await request("/ehr/patients/pat_001/pharmacy");
  await request("/ehr/patients/pat_001/pharmacy", "PUT", {
    pharmacyId: "ph_001",
  });
  await refill("pat_001", "m_unknown");
  const calls = (await request("/__calls")).body;
  assert.deepEqual(
    calls.map((call: { status: number; response: unknown }) => ({
      status: call.status,
      response: call.response,
    })),
    [
      { status: 200, response: { count: 1, patientId: "pat_001" } },
      { status: 200, response: { pharmacyId: "ph_002", name: "Mission Rx" } },
      { status: 200, response: { ok: true } },
      { status: 404, response: { error: "medication not found" } },
    ],
  );
  assert.deepEqual(calls[0].query, {});
});

test("harness faults reject invalid input and consume configured failures without mutating", async (t) => {
  const { request } = await startMock(t);
  assert.equal(
    (
      await request("/__harness/faults", "POST", {
        method: "GET",
        path: "https://outside.test",
      })
    ).status,
    400,
  );
  await request("/__harness/faults", "POST", {
    method: "GET",
    path: "/ehr/time",
    times: 1,
  });
  assert.equal((await request("/ehr/time")).status, 503);
  assert.equal((await request("/ehr/time")).status, 200);
  await request("/__harness/faults", "POST", {
    method: "PUT",
    path: "/ehr/patients/pat_001/pharmacy",
    times: 20,
  });
  assert.equal(
    (
      await request("/ehr/patients/pat_001/pharmacy", "PUT", {
        pharmacyId: "ph_001",
      })
    ).status,
    503,
  );
  assert.equal(
    (await request("/ehr/patients/pat_001/pharmacy")).body.pharmacyId,
    "ph_002",
  );
});
