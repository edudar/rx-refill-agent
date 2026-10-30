// Mock EHR/pharmacy transport. Service authorization is not patient authentication.
import { createServer, type IncomingMessage } from "node:http";
import type { Dataset } from "./types.js";
import {
  readRequest,
  sendResponse,
  type MockRequest,
  type MockResponse,
} from "./http.js";
import { createMockState, recordRequest, type MockState } from "./state.js";
import { handleEhrRequest } from "./ehr.js";

interface MockServerOptions {
  dataset: Dataset;
  now?: string;
  ehrApiKey: string;
  pharmacyApiKey: string;
}

export function createMockServer(options: MockServerOptions) {
  const { state, reset } = createMockState(options.dataset, options.now);
  return createServer(async (req, res) => {
    const request = await readRequest(req);
    const localResponse = handleIntrospection(request, state, reset);
    if (localResponse) return sendResponse(res, localResponse);
    if (!isAuthorized(req, request, options))
      return sendResponse(res, {
        status: 401,
        body: { error: "unauthorized" },
      });
    if (["ehr", "pharmacy"].includes(request.segments[0]))
      recordRequest(state, request);
    const response = handleEhrRequest(request, state) ??
      handlePharmacyDirectory(request, state) ?? {
        status: 404,
        body: {
          error: "not found",
          method: request.method,
          path: request.path,
        },
      };
    sendResponse(res, response);
  });
}

function handleIntrospection(
  { path, method }: MockRequest,
  state: MockState,
  reset: () => void,
): MockResponse | undefined {
  if (path === "/__reset" && method === "POST") {
    reset();
    return { status: 200, body: { ok: true } };
  }
  if (path === "/__calls" && method === "GET")
    return { status: 200, body: state.calls };
  if (path === "/healthz") return { status: 200, body: { ok: true } };
}

function isAuthorized(
  req: IncomingMessage,
  request: MockRequest,
  options: MockServerOptions,
) {
  const service = request.segments[0];
  if (service !== "ehr" && service !== "pharmacy") return true;
  const key = service === "ehr" ? options.ehrApiKey : options.pharmacyApiKey;
  return req.headers.authorization === `Bearer ${key}`;
}

function handlePharmacyDirectory(
  request: MockRequest,
  { data }: MockState,
): MockResponse | undefined {
  if (request.path !== "/pharmacy/directory" || request.method !== "GET")
    return;
  const query = (request.query.get("q") ?? "").toLowerCase();
  const matches = data.pharmacies.filter(
    (pharmacy) =>
      !query ||
      pharmacy.name.toLowerCase().includes(query) ||
      pharmacy.address.toLowerCase().includes(query),
  );
  return { status: 200, body: matches };
}
