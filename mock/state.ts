import type { MockFault } from "./faults.js";
import type { Dataset } from "./types.js";
import type { MockRequest } from "./http.js";

interface CallRecord {
  seq: number;
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
  // Harness additions; starter consumers ignore these fields.
  status?: number;
  response?: unknown;
}

export interface MockState {
  data: Dataset;
  now: string;
  calls: CallRecord[];
  refillCounter: number;
  callSequence: number;
  faults: MockFault[];
}

export function createMockState(dataset: Dataset, now = dataset.now) {
  const initialData = structuredClone(dataset);
  const state: MockState = {
    data: structuredClone(initialData),
    now,
    calls: [],
    refillCounter: 0,
    callSequence: 0,
    faults: [],
  };
  return {
    state,
    // Starter POST /__reset semantics: only the request log is cleared.
    clearCalls() {
      state.calls = [];
      state.callSequence = 0;
    },
    // Harness-only: return the whole mock to its startup state.
    restore() {
      state.data = structuredClone(initialData);
      state.calls = [];
      state.refillCounter = 0;
      state.callSequence = 0;
      state.faults = [];
    },
  };
}

export function recordRequest(state: MockState, request: MockRequest) {
  const call: CallRecord = {
    seq: ++state.callSequence,
    method: request.method,
    path: request.path,
    query: Object.fromEntries(request.query),
    body: request.body,
  };
  state.calls.push(call);
  return call;
}

export function submitRefill(state: MockState) {
  return { refillId: `rf_${++state.refillCounter}`, status: "submitted" };
}
