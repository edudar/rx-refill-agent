import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

const credentials = { OPENAI_API_KEY: "test-key", OPENAI_MODEL: "test-model" };

test("configuration loads explicitly with existing service defaults and no reasoning override", () => {
  const config = loadConfig(credentials);
  assert.deepEqual(config, {
    openai: { apiKey: "test-key", model: "test-model", reasoning: undefined },
    ehr: { baseUrl: "http://localhost:4010", apiKey: "dev-ehr-key" },
    port: 5050,
    conversationLogging: true,
  });
});

test("configuration accepts environment overrides without retaining unrelated variables", () => {
  const config = loadConfig({
    ...credentials,
    OPENAI_REASONING_EFFORT: "low",
    AGENT_PORT: "6060",
    EHR_BASE_URL: "https://ehr.example.test",
    EHR_API_KEY: "custom-ehr-key",
    UNRELATED_SETTING: "not-agent-configuration",
    CONVERSATION_LOGGING: "false",
  });
  assert.deepEqual(config, {
    openai: {
      apiKey: "test-key",
      model: "test-model",
      reasoning: { effort: "low" },
    },
    ehr: { baseUrl: "https://ehr.example.test", apiKey: "custom-ehr-key" },
    port: 6060,
    conversationLogging: false,
  });
});

test("configuration fails before startup for missing credentials or invalid settings", () => {
  for (const env of [
    {},
    { OPENAI_MODEL: "test-model" },
    { OPENAI_API_KEY: "test-key" },
    { ...credentials, OPENAI_REASONING_EFFORT: "unknown" },
    { ...credentials, AGENT_PORT: "not-a-port" },
    { ...credentials, AGENT_PORT: "0" },
    { ...credentials, AGENT_PORT: "65536" },
    { ...credentials, EHR_BASE_URL: "file:///tmp/ehr" },
    { ...credentials, EHR_BASE_URL: "not-a-url" },
    { ...credentials, CONVERSATION_LOGGING: "invalid" },
  ]) {
    assert.throws(() => loadConfig(env));
  }
});
