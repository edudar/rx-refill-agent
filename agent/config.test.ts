import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

const credentials = { OPENAI_API_KEY: "test-key", OPENAI_MODEL: "test-model" };

test("configuration defaults to the validated model and an explicit reasoning effort", () => {
  for (const env of [
    { OPENAI_API_KEY: "test-key" },
    {
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: "",
      OPENAI_REASONING_EFFORT: "",
    },
  ]) {
    assert.deepEqual(loadConfig(env).openai, {
      apiKey: "test-key",
      model: "gpt-6-luna",
      reasoning: { effort: "none" },
    });
  }
});

test("configuration loads explicitly with existing service defaults", () => {
  const config = loadConfig(credentials);
  assert.deepEqual(config, {
    openai: {
      apiKey: "test-key",
      model: "test-model",
      reasoning: { effort: "none" },
    },
    ehr: { baseUrl: "http://localhost:4010", apiKey: "dev-ehr-key" },
    pharmacy: {
      baseUrl: "http://localhost:4010",
      apiKey: "dev-pharmacy-key",
    },
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
    PHARMACY_BASE_URL: "https://pharmacy.example.test",
    PHARMACY_API_KEY: "custom-pharmacy-key",
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
    pharmacy: {
      baseUrl: "https://pharmacy.example.test",
      apiKey: "custom-pharmacy-key",
    },
    port: 6060,
    conversationLogging: false,
  });
});

test("configuration fails before startup for missing credentials or invalid settings", () => {
  for (const env of [
    {},
    { OPENAI_MODEL: "test-model" },
    { OPENAI_API_KEY: "", OPENAI_MODEL: "test-model" },
    { ...credentials, OPENAI_REASONING_EFFORT: "unknown" },
    { ...credentials, AGENT_PORT: "not-a-port" },
    { ...credentials, AGENT_PORT: "0" },
    { ...credentials, AGENT_PORT: "65536" },
    { ...credentials, EHR_BASE_URL: "file:///tmp/ehr" },
    { ...credentials, EHR_BASE_URL: "not-a-url" },
    { ...credentials, PHARMACY_BASE_URL: "ftp://pharmacy.test" },
    { ...credentials, CONVERSATION_LOGGING: "invalid" },
  ]) {
    assert.throws(() => loadConfig(env));
  }
});
