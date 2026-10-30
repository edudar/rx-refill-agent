import assert from "node:assert/strict";
import test from "node:test";
import { createEhrClient } from "./ehr.js";
import {
  ServiceRequestError,
  type ServiceFailureKind,
} from "../contracts/service-errors.js";

test("EHR requests use service auth, fixed routes, deadlines, and encoded patient IDs", async () => {
  const calls: string[] = [];
  const ehr = createEhrClient({
    baseUrl: "http://ehr.test",
    apiKey: "ehr-test-key",
    fetch: async (url, init) => {
      calls.push(String(url));
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer ehr-test-key",
      );
      assert.ok(init?.signal);
      assert.equal(init?.redirect, "error");
      if (init?.method === "POST") {
        assert.deepEqual(JSON.parse(String(init.body)), {
          factors: { firstName: "Alice" },
        });
        return Response.json({ count: 1, patientId: "p/1" });
      }
      return Response.json({
        patientId: "p/1",
        firstName: "Alice",
        lastName: "Nguyen",
        dob: "1988-03-12",
        phone: "415-555-1234",
        zip: "94107",
      });
    },
  });
  const match = await ehr.match({ firstName: "Alice" });
  await ehr.getPatient(match.patientId!);
  assert.deepEqual(calls, [
    "http://ehr.test/ehr/patients:match",
    "http://ehr.test/ehr/patients/p%2F1",
  ]);
});

test("EHR rejects failed requests, inconsistent match responses, and wrong patient IDs", async () => {
  for (const response of [
    () => Response.json({ error: "private details" }, { status: 503 }),
    () => Response.json({ count: 1, patientId: null }),
    () => Response.json({ count: -1, patientId: null }),
    () => Response.json({ count: 2, patientId: "p-1" }),
  ]) {
    const ehr = createEhrClient({
      baseUrl: "http://ehr.test",
      apiKey: "test",
      fetch: async () => response(),
    });
    await assert.rejects(ehr.match({ firstName: "Alice" }));
  }
  const ehr = createEhrClient({
    baseUrl: "http://ehr.test",
    apiKey: "test",
    fetch: async () =>
      Response.json({
        patientId: "other",
        firstName: "Alice",
        lastName: "Nguyen",
        dob: "1988-03-12",
        phone: "1234",
        zip: "94107",
      }),
  });
  await assert.rejects(ehr.getPatient("p-1"));
});

test("EHR record and write routes encode IDs and validate responses", async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const responses: Record<string, unknown> = {
    "GET /ehr/time": { now: "2026-09-01T12:00:00Z" },
    "GET /ehr/patients/p%2F1/medications": [],
    "GET /ehr/patients/p%2F1/labs": [
      { type: "INR", value: "2.1", takenDate: "2026-08-20" },
    ],
    "GET /ehr/patients/p%2F1/pharmacy": null,
    "PUT /ehr/patients/p%2F1/pharmacy": { ok: true },
    "POST /ehr/patients/p%2F1/refills": {
      refillId: "rf_1",
      status: "submitted",
    },
  };
  const ehr = createEhrClient({
    baseUrl: "http://ehr.test",
    apiKey: "test",
    fetch: async (url, init) => {
      const { pathname, search } = new URL(String(url));
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url: pathname + search,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json(responses[`${method} ${pathname}`]);
    },
  });
  assert.equal(await ehr.getTime(), "2026-09-01T12:00:00Z");
  assert.deepEqual(await ehr.getMedications("p/1"), []);
  assert.equal((await ehr.getLabs("p/1", "INR & K"))[0].type, "INR");
  assert.equal(await ehr.getPharmacy("p/1"), null);
  await ehr.setPharmacy("p/1", "ph_2");
  assert.deepEqual(await ehr.submitRefill("p/1", "m_1"), {
    refillId: "rf_1",
    status: "submitted",
  });
  assert.deepEqual(calls, [
    { method: "GET", url: "/ehr/time", body: undefined },
    { method: "GET", url: "/ehr/patients/p%2F1/medications", body: undefined },
    {
      method: "GET",
      url: "/ehr/patients/p%2F1/labs?type=INR+%26+K",
      body: undefined,
    },
    { method: "GET", url: "/ehr/patients/p%2F1/pharmacy", body: undefined },
    {
      method: "PUT",
      url: "/ehr/patients/p%2F1/pharmacy",
      body: { pharmacyId: "ph_2" },
    },
    {
      method: "POST",
      url: "/ehr/patients/p%2F1/refills",
      body: { medId: "m_1" },
    },
  ]);
});

test("EHR failures say whether the service could have acted on the request", async () => {
  const cases: [() => Promise<Response>, ServiceFailureKind][] = [
    [async () => Response.json({ error: "x" }, { status: 409 }), "rejected"],
    [async () => Response.json({ error: "x" }, { status: 503 }), "unavailable"],
    [
      async () => {
        throw new TypeError("socket hang up");
      },
      "no_response",
    ],
    [async () => new Response("not json"), "invalid_response"],
    [async () => Response.json({ refillId: "rf_1" }), "invalid_response"],
  ];
  for (const [response, kind] of cases) {
    const ehr = createEhrClient({
      baseUrl: "http://ehr.test",
      apiKey: "test",
      fetch: response,
    });
    await assert.rejects(
      ehr.submitRefill("p-1", "m-1"),
      (error) =>
        error instanceof ServiceRequestError &&
        error.kind === kind &&
        !/socket|"x"/.test(error.message),
    );
  }
});

test("malformed clinical records are rejected whole", async () => {
  const medication = {
    medId: "m-1",
    name: "Lisinopril 10mg",
    isControlled: false,
    schedule: null,
    lastFilledDate: "2026-08-01",
    daysSupply: 30,
    refillsRemaining: 2,
    rxExpirationDate: "2027-01-01",
    requiresRecentLab: null,
  };
  for (const malformed of [
    { refillsRemaining: -1 },
    { schedule: "C2" },
    { rxExpirationDate: "next year" },
    { requiresRecentLab: { type: "INR" } },
  ]) {
    const ehr = createEhrClient({
      baseUrl: "http://ehr.test",
      apiKey: "test",
      fetch: async () =>
        Response.json([medication, { ...medication, ...malformed }]),
    });
    await assert.rejects(ehr.getMedications("p-1"), /invalid_response/);
  }
});
