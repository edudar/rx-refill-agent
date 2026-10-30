import assert from "node:assert/strict";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { createAgentServer } from "./server.js";
import type { TurnHandler } from "./contracts/conversation.js";

async function startServer(t: TestContext, handleTurn: TurnHandler) {
  const server = createAgentServer(handleTurn);
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
  return `http://127.0.0.1:${address.port}`;
}

test("HTTP server exposes health and forwards valid messages to the turn handler", async (t) => {
  const calls: [string, string][] = [];
  const reply = {
    messages: [{ from: "agent" as const, text: "How can I help?" }],
    state: "in_progress" as const,
  };
  const base = await startServer(t, async (id, text) => {
    calls.push([id, text]);
    return reply;
  });
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(calls.length, 0);
  const response = await fetch(`${base}/conversations/server-test/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "patient", text: "  I need my rx  " }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), reply);
  assert.deepEqual(calls, [["server-test", "I need my rx"]]);
});

test("HTTP server rejects invalid requests without invoking the conversation workflow", async (t) => {
  let calls = 0;
  const base = await startServer(t, async () => {
    calls++;
    throw new Error("Invalid input reached the workflow");
  });
  for (const body of [
    "{",
    "null",
    JSON.stringify({ from: "agent", text: "hello" }),
    JSON.stringify({ from: "patient", text: " " }),
    JSON.stringify({ from: "patient", text: "x".repeat(2_001) }),
  ]) {
    const response = await fetch(`${base}/conversations/invalid/messages`, {
      method: "POST",
      body,
    });
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  }
  const oversized = await fetch(`${base}/conversations/invalid/messages`, {
    method: "POST",
    body: "x".repeat(17_000),
  });
  assert.equal(oversized.status, 413);
  await oversized.arrayBuffer();
  const longId = await fetch(
    `${base}/conversations/${"x".repeat(201)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ from: "patient", text: "hello" }),
    },
  );
  assert.equal(longId.status, 400);
  await longId.arrayBuffer();
  for (const path of ["/unknown", "/conversations/invalid/messages"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404);
    await response.arrayBuffer();
  }
  assert.equal(calls, 0);
});

test("HTTP server returns a generic error when the turn handler fails", async (t) => {
  const base = await startServer(t, async () => {
    throw new Error("private upstream details");
  });
  const response = await fetch(`${base}/conversations/server-test/messages`, {
    method: "POST",
    body: JSON.stringify({ from: "patient", text: "hello" }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Unable to process message",
  });
});
