import assert from "node:assert/strict";
import test from "node:test";
import { expectedMockFixture } from "./fixtures.js";
import { runConformanceSuite } from "./suite.js";
import type { RecordedCall, ScenarioResult } from "./contracts.js";

test("isolates scenarios, assigns fresh IDs, skips unsupported scenarios, and reports failures without stopping the suite", async () => {
  const sequence: string[] = [];
  const reports: ScenarioResult[] = [];
  let recorded: RecordedCall[] = [];
  const results = await runConformanceSuite({
    agentBase: "http://agent.test",
    mockBase: "http://mock.test",
    onResult: (result) => reports.push(result),
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/healthz") return Response.json({ ok: true });
      if (path === "/__harness")
        return Response.json({
          ...expectedMockFixture,
          capabilities: ["restore", "call-outcomes"],
        });
      if (path === "/__harness/restore") {
        sequence.push("reset");
        recorded = [];
        return Response.json({ ok: true });
      }
      if (path === "/__calls") return Response.json(recorded);
      sequence.push("message");
      recorded.push({ seq: 1, method: "POST", path: "/ehr/patients:match" });
      return Response.json(
        {
          messages: [{ from: "agent", text: "Please identify yourself." }],
          state: "in_progress",
        },
        { headers: { "cache-control": "no-store" } },
      );
    },
    scenarios: [
      {
        name: "first",
        description: "Deliberate failure",
        async run(context) {
          assert.deepEqual(await context.calls(), []);
          await context.send("hello");
          assert.equal((await context.calls()).length, 1);
          context.check(false, "expected assertion failure");
          throw new Error("expected scenario exception");
        },
      },
      {
        name: "unavailable",
        description: "Needs a capability the mock lacks",
        requires: ["restore", "faults"],
        async run() {
          sequence.push("unavailable ran");
        },
      },
      {
        name: "second",
        description: "Subsequent scenario",
        async run(context) {
          assert.deepEqual(await context.calls(), []);
          await context.send("hello again");
        },
      },
    ],
  });
  assert.deepEqual(sequence, ["reset", "message", "reset", "message"]);
  assert.deepEqual(results[0].failures, [
    "expected assertion failure",
    "expected scenario exception",
  ]);
  assert.deepEqual(results[1], {
    ...results[1],
    failures: [],
    skipped: "mock lacks faults",
  });
  assert.deepEqual(results[2].failures, []);
  assert.equal(results[2].skipped, undefined);
  assert.deepEqual(reports, results);
  assert.notEqual(results[0].conversationId, results[2].conversationId);
  for (const result of results)
    assert.match(result.conversationId, /^[a-z]+-[0-9a-f-]{36}$/);
});

test("failed service readiness prevents scenarios from running", async () => {
  const results: string[] = [];
  await assert.rejects(
    runConformanceSuite({
      agentBase: "http://agent.test",
      mockBase: "http://mock.test",
      fetch: async (url) =>
        Response.json(
          { ok: false },
          { status: String(url).includes("mock.test") ? 503 : 200 },
        ),
      scenarios: [
        {
          name: "unused",
          description: "Must not run",
          async run() {
            results.push("ran");
          },
        },
      ],
    }),
    /mock \/healthz returned HTTP 503/,
  );
  assert.deepEqual(results, []);
});
