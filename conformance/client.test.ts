import assert from "node:assert/strict";
import test from "node:test";
import { createConformanceClient } from "./client.js";

test("related conversations use different message URLs while sharing mock controls and checks", async () => {
  const sent: { path: string; body: unknown }[] = [];
  const client = createConformanceClient({
    agentBase: "http://agent.test",
    mockBase: "http://mock.test",
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      sent.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (path === "/__harness/faults") return Response.json({ ok: true });
      return Response.json(
        { state: "in_progress", messages: [{ from: "agent", text: "Hello." }] },
        { headers: { "cache-control": "no-store" } },
      );
    },
  });
  const failures: string[] = [];
  const parent = client.context("fresh-uuid", (ok, text) => {
    if (!ok) failures.push(text);
  });
  const child = parent.conversation("second");
  await parent.send("Alice");
  await child.send("Omar");
  await child.fault("PUT", "/ehr/patients/pat_001/pharmacy");
  child.check(false, "isolated failure");
  assert.deepEqual(
    sent.map((call) => call.path),
    [
      "/conversations/fresh-uuid/messages",
      "/conversations/fresh-uuid-second/messages",
      "/__harness/faults",
    ],
  );
  assert.deepEqual(sent[2].body, {
    method: "PUT",
    path: "/ehr/patients/pat_001/pharmacy",
    times: 20,
  });
  assert.deepEqual(failures, ["second: isolated failure"]);
});

test("a starter mock without /__harness offers no capabilities and resets with /__reset", async () => {
  const paths: string[] = [];
  const client = createConformanceClient({
    agentBase: "http://agent.test",
    mockBase: "http://mock.test",
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return path === "/__harness"
        ? Response.json({ error: "not found" }, { status: 404 })
        : Response.json({ ok: true });
    },
  });
  const harness = await client.harness();
  assert.equal(harness.capabilities.size, 0);
  assert.match(harness.notes[0], /starter mock/);
  await client.reset(harness);
  assert.deepEqual(paths, ["/__harness", "/__reset"]);
});

test("the extended harness restores state and grants the fixture only for a matching clock and patients", async () => {
  const { expectedMockFixture } = await import("./fixtures.js");
  const capabilities = ["restore", "faults", "call-outcomes", "unknown"];
  for (const [fixture, expected] of [
    [expectedMockFixture, /^$/],
    [{ ...expectedMockFixture, now: "2030-01-01T00:00:00Z" }, /fixture clock/],
    [{ ...expectedMockFixture, patientIds: [] }, /mock:conformance/],
  ] as const) {
    const paths: string[] = [];
    const client = createConformanceClient({
      agentBase: "http://agent.test",
      mockBase: "http://mock.test",
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        return Response.json(
          path === "/__harness" ? { ...fixture, capabilities } : { ok: true },
        );
      },
    });
    const harness = await client.harness();
    assert.match(harness.notes.join(" "), expected);
    assert.deepEqual(
      [...harness.capabilities].sort(),
      [
        "call-outcomes",
        "faults",
        "restore",
        ...(harness.notes.length ? [] : ["conformance-fixture"]),
      ].sort(),
    );
    await client.reset(harness);
    assert.deepEqual(paths, ["/__harness", "/__harness/restore"]);
  }
});
