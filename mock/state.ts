import type { Dataset, Medication } from "./types.js";
import type { MockRequest } from "./http.js";
import { parseSimulatedDay } from "./refill-rules.js";

interface CallRecord {
  seq: number;
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

export interface MockState {
  data: Dataset;
  now: string;
  calls: CallRecord[];
  refillCounter: number;
  callSequence: number;
}

export function createMockState(dataset: Dataset, now = dataset.now) {
  parseSimulatedDay(now);
  const initialData = structuredClone(dataset);
  const state: MockState = {
    data: structuredClone(initialData),
    now,
    calls: [],
    refillCounter: 0,
    callSequence: 0,
  };
  return {
    state,
    reset() {
      state.data = structuredClone(initialData);
      state.calls = [];
      state.refillCounter = 0;
      state.callSequence = 0;
    },
  };
}

export function recordRequest(state: MockState, request: MockRequest) {
  state.calls.push({
    seq: ++state.callSequence,
    method: request.method,
    path: request.path,
    query: Object.fromEntries(request.query),
    body: request.body,
  });
}

export function submitRefill(state: MockState, medication: Medication) {
  medication.refillsRemaining--;
  // Submission is not confirmation of dispensing; lastFilledDate stays unchanged.
  return { refillId: `rf_${++state.refillCounter}`, status: "submitted" };
}
