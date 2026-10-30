// Mock EHR/pharmacy transport. Service authorization is not patient authentication.
//
// /ehr/*, /pharmacy/*, /healthz, POST /__reset, and GET /__calls keep the starter mock's
// behavior, because the grader runs against that mock. Local test controls live only under
// /__harness/*; call records additionally carry `status` and `response`.
import { createServer, type IncomingMessage } from "node:http";
import type { Dataset } from "./types.js";
import {
  readRequest,
  sendResponse,
  type MockRequest,
  type MockResponse,
} from "./http.js";
import { createMockState, recordRequest, type MockState } from "./state.js";
import { configureFault, consumeFault } from "./faults.js";
import { handleEhrRequest } from "./ehr.js";

interface MockServerOptions {
  dataset: Dataset;
  now?: string;
  ehrApiKey: string;
  pharmacyApiKey: string;
}

type MockControls = ReturnType<typeof createMockState>;

export const harnessCapabilities = [
  "restore",
  "faults",
  "call-outcomes",
] as const;

export function createMockServer(options: MockServerOptions) {
  const controls = createMockState(options.dataset, options.now);
  return createServer(async (req, res) => {
    const request = await readRequest(req);
    const localResponse =
      handleStarterIntrospection(request, controls) ??
      handleHarness(request, controls);
    if (localResponse) return sendResponse(res, localResponse);
    sendResponse(
      res,
      handleServiceRequest(req, request, options, controls.state),
    );
  });
}

function handleServiceRequest(
  req: IncomingMessage,
  request: MockRequest,
  options: MockServerOptions,
  state: MockState,
): MockResponse {
  // As in the starter mock, unauthorized requests are rejected before being recorded.
  if (!isAuthorized(req, request, options))
    return { status: 401, body: { error: "unauthorized" } };
  const call = ["ehr", "pharmacy"].includes(request.segments[0])
    ? recordRequest(state, request)
    : undefined;
  const response: MockResponse = consumeFault(request, state) ??
    handleEhrRequest(request, state) ??
    handlePharmacyDirectory(request, state) ?? {
      status: 404,
      body: {
        error: "not found",
        method: request.method,
        path: request.path,
      },
    };
  if (call) {
    call.status = response.status;
    call.response = structuredClone(response.body);
  }
  return response;
}

function handleStarterIntrospection(
  { path, method }: MockRequest,
  controls: MockControls,
): MockResponse | undefined {
  if (path === "/__reset" && method === "POST") {
    controls.clearCalls();
    return { status: 200, body: { ok: true } };
  }
  if (path === "/__calls" && method === "GET")
    return { status: 200, body: controls.state.calls };
  if (path === "/healthz") return { status: 200, body: { ok: true } };
}

function handleHarness(
  request: MockRequest,
  { state, restore }: MockControls,
): MockResponse | undefined {
  const { path, method } = request;
  if (path === "/__harness" && method === "GET")
    return {
      status: 200,
      body: {
        capabilities: harnessCapabilities,
        now: state.now,
        patientIds: state.data.patients.map((patient) => patient.patientId),
      },
    };
  if (path === "/__harness/restore" && method === "POST") {
    restore();
    return { status: 200, body: { ok: true } };
  }
  if (path === "/__harness/faults" && method === "POST")
    return configureFault(request.body, state);
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
