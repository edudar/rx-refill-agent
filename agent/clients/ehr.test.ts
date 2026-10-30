import assert from "node:assert/strict";
import test from "node:test";
import { createEhrClient } from "./ehr.js";

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
