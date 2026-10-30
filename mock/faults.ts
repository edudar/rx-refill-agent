import { z } from "zod";
import type { MockState } from "./state.js";
import type { MockRequest, MockResponse } from "./http.js";

const faultSchema = z.object({
  method: z.enum(["GET", "POST", "PUT"]),
  path: z.string().startsWith("/ehr/"),
  times: z.number().int().min(1).max(20).default(1),
});
export type MockFault = z.infer<typeof faultSchema>;

export function configureFault(body: unknown, state: MockState): MockResponse {
  const parsed = faultSchema.safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: "invalid fault" } };
  state.faults.push(parsed.data);
  return { status: 200, body: { ok: true } };
}

export function consumeFault(
  request: MockRequest,
  state: MockState,
): MockResponse | undefined {
  const fault = state.faults.find(
    (fault) =>
      fault.times > 0 &&
      fault.method === request.method &&
      fault.path === request.path,
  );
  if (!fault) return;
  fault.times--;
  return { status: 503, body: { error: "simulated_service_unavailable" } };
}
