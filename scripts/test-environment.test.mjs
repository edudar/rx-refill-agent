import assert from "node:assert/strict";
import test from "node:test";
import "./test-environment.mjs";

test("unit tests do not inherit model or service credentials", () => {
  for (const name of [
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "EHR_API_KEY",
    "PHARMACY_API_KEY",
  ]) {
    assert.equal(process.env[name], undefined);
  }
});

test("unit tests block outbound HTTP and HTTPS before sending requests", () => {
  for (const url of [
    "https://api.openai.com/v1/responses",
    "http://ehr.test/ehr/patients",
    "http://localhost.example.test/",
  ]) {
    assert.throws(
      () => fetch(url),
      /only injected transports or loopback HTTP/,
    );
  }
});
