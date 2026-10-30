// Unit tests use injected transports and loopback HTTP, never live services.
for (const name of [
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "EHR_API_KEY",
  "PHARMACY_API_KEY",
]) {
  delete process.env[name];
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error(
      "Unit tests allow only injected transports or loopback HTTP",
    );
  }
  return originalFetch(input, init);
};
