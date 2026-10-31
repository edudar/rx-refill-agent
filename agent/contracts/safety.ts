import { z } from "zod";

// Signals both extraction models report on every patient message. Application
// code acts on them before anything else, in every phase.
export const urgentSafetySchema = z.enum([
  "none",
  "medical_emergency",
  "mental_health_crisis",
]);

export const safetySignalShape = {
  urgentSafety: urgentSafetySchema,
  // A request for medical advice, which the agent never gives.
  clinicalQuestion: z.boolean(),
};

export type UrgentSafety = z.infer<typeof urgentSafetySchema>;
