import assert from "node:assert/strict";
import { agentReplySchema } from "../agent/contracts/conversation.js";
import { recordedCallsSchema, type ScenarioContext } from "./contracts.js";

export function createConformanceClient(options: {
  agentBase: string;
  mockBase: string;
  fetch?: typeof globalThis.fetch;
}) {
  const request = (url: string, init?: RequestInit) =>
    (options.fetch ?? globalThis.fetch)(url, {
      ...init,
      signal: AbortSignal.timeout(45_000),
    });
  const json = async (url: string, init?: RequestInit): Promise<unknown> => {
    const response = await request(url, init);
    assert.ok(
      response.ok,
      `HTTP ${response.status} from ${new URL(url).pathname}`,
    );
    return response.json();
  };

  return {
    async health() {
      for (const [name, base] of [
        ["agent", options.agentBase],
        ["mock", options.mockBase],
      ]) {
        const response = await request(`${base}/healthz`);
        await response.arrayBuffer();
        assert.ok(
          response.ok,
          `${name} /healthz returned HTTP ${response.status}`,
        );
      }
    },
    async reset() {
      await json(`${options.mockBase}/__reset`, { method: "POST" });
    },
    context(
      conversationId: string,
      check: ScenarioContext["check"],
    ): ScenarioContext {
      const sendRaw = (body: string) =>
        request(
          `${options.agentBase}/conversations/${conversationId}/messages`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          },
        );
      return {
        conversationId,
        check,
        async send(text) {
          const response = await sendRaw(
            JSON.stringify({ from: "patient", text }),
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
        },
        async calls() {
          return recordedCallsSchema.parse(
            await json(`${options.mockBase}/__calls`),
          );
        },
      };
    },
  };
}
