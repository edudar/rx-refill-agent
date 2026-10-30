import assert from "node:assert/strict";
import { agentReplySchema } from "../agent/contracts/conversation.js";
import { recordedCallsSchema, type ScenarioContext } from "./contracts.js";

interface ConformanceClientOptions {
  agentBase: string;
  mockBase: string;
  fetch?: typeof globalThis.fetch;
}

type Request = (url: string, init?: RequestInit) => Promise<Response>;

export function createConformanceClient(options: ConformanceClientOptions) {
  const request: Request = (url, init) =>
    (options.fetch ?? globalThis.fetch)(url, {
      ...init,
      signal: AbortSignal.timeout(45_000),
    });
  return {
    health: () => checkServiceHealth(request, options),
    async reset() {
      await requestJson(request, `${options.mockBase}/__reset`, {
        method: "POST",
      });
    },
    context: (conversationId: string, check: ScenarioContext["check"]) =>
      createScenarioContext(request, options, conversationId, check),
  };
}

async function requestJson(
  request: Request,
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await request(url, init);
  assert.ok(
    response.ok,
    `HTTP ${response.status} from ${new URL(url).pathname}`,
  );
  return response.json();
}

async function checkServiceHealth(
  request: Request,
  options: ConformanceClientOptions,
) {
  for (const [name, base] of [
    ["agent", options.agentBase],
    ["mock", options.mockBase],
  ]) {
    const response = await request(`${base}/healthz`);
    await response.arrayBuffer();
    assert.ok(response.ok, `${name} /healthz returned HTTP ${response.status}`);
  }
}

function createScenarioContext(
  request: Request,
  options: ConformanceClientOptions,
  conversationId: string,
  check: ScenarioContext["check"],
): ScenarioContext {
  return {
    conversationId,
    check,
    send: (text) =>
      sendPatientMessage(request, options.agentBase, conversationId, text),
    calls: async () =>
      recordedCallsSchema.parse(
        await requestJson(request, `${options.mockBase}/__calls`),
      ),
  };
}

async function sendPatientMessage(
  request: Request,
  agentBase: string,
  conversationId: string,
  text: string,
) {
  const response = await request(
    `${agentBase}/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "patient", text }),
    },
  );
  assert.ok(
    response.ok,
    `agent returned HTTP ${response.status} for a message`,
  );
  assert.equal(
    response.headers.get("cache-control"),
    "no-store",
    "agent replies must not be cached",
  );
  return agentReplySchema.parse(await response.json());
}
