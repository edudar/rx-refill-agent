import assert from "node:assert/strict";
import { z } from "zod";
import { expectedMockFixture } from "./fixtures.js";
import { agentReplySchema } from "../agent/contracts/conversation.js";
import {
  harnessCapabilities,
  recordedCallsSchema,
  type HarnessCapability,
  type ScenarioContext,
} from "./contracts.js";

interface ConformanceClientOptions {
  agentBase: string;
  mockBase: string;
  fetch?: typeof globalThis.fetch;
}

type Request = (url: string, init?: RequestInit) => Promise<Response>;

export interface HarnessSupport {
  capabilities: ReadonlySet<HarnessCapability>;
  // Why capabilities are missing, for the run report.
  notes: string[];
}

export function createConformanceClient(options: ConformanceClientOptions) {
  const request: Request = (url, init) =>
    (options.fetch ?? globalThis.fetch)(url, {
      ...init,
      signal: AbortSignal.timeout(45_000),
    });
  return {
    health: () => checkServiceHealth(request, options),
    harness: () => discoverHarness(request, options.mockBase),
    async reset(harness: HarnessSupport) {
      // The starter /__reset only clears the call log; restore also resets patient state.
      const path = harness.capabilities.has("restore")
        ? "/__harness/restore"
        : "/__reset";
      await requestJson(request, `${options.mockBase}${path}`, {
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

const harnessDescriptionSchema = z.object({
  capabilities: z.array(z.string()),
  now: z.string(),
  patientIds: z.array(z.string()),
});

async function discoverHarness(
  request: Request,
  mockBase: string,
): Promise<HarnessSupport> {
  const response = await request(`${mockBase}/__harness`);
  if (response.status === 404) {
    await response.arrayBuffer();
    return {
      capabilities: new Set(),
      notes: [
        "mock has no /__harness (starter mock); only starter-compatible scenarios run",
      ],
    };
  }
  assert.ok(response.ok, `HTTP ${response.status} from /__harness`);
  const harness = harnessDescriptionSchema.parse(await response.json());
  const capabilities = new Set(
    harnessCapabilities.filter((capability) =>
      harness.capabilities.includes(capability),
    ),
  );
  const notes = fixtureMismatches(harness);
  if (!notes.length) capabilities.add("conformance-fixture");
  return { capabilities, notes };
}

function fixtureMismatches(harness: z.infer<typeof harnessDescriptionSchema>) {
  const notes: string[] = [];
  if (harness.now !== expectedMockFixture.now)
    notes.push(
      `mock clock ${harness.now} is not the fixture clock ${expectedMockFixture.now}; unset SIM_NOW`,
    );
  const missing = expectedMockFixture.patientIds.filter(
    (id) => !harness.patientIds.includes(id),
  );
  if (missing.length)
    notes.push(
      `mock is missing fixture patients ${missing.join(", ")}; start it with npm run mock:conformance`,
    );
  return notes;
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
    async fault(method, path) {
      await requestJson(request, `${options.mockBase}/__harness/faults`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, path, times: 20 }),
      });
    },
    conversation: (label) =>
      createScenarioContext(
        request,
        options,
        `${conversationId}-${label}`,
        (condition, message) => check(condition, `${label}: ${message}`),
      ),
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
