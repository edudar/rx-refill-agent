import { z } from "zod";
import type { IdentityFactors } from "../domain/identity.js";
import { safetySignalShape } from "./safety.js";

// Raw proposals may be incomplete or invalid; domain validators decide what to keep.
export const identityUpdateSchema = z.object({
  ...safetySignalShape,
  outOfScope: z.boolean(),
  // A question (such as why a detail is needed) is not a non-answer.
  isQuestion: z.boolean(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  dob: z.string().nullable(),
  phoneLast4: z.string().nullable(),
  zip: z.string().nullable(),
  // Unresolved patient wording; only matched against records after verification.
  medicationMention: z.string().nullable(),
});

export type IdentityUpdate = z.infer<typeof identityUpdateSchema>;
export interface ExtractionInput {
  text: string;
  factors: IdentityFactors;
  lastPrompt: string;
}
export type IdentityExtractor = (
  input: ExtractionInput,
) => Promise<IdentityUpdate>;
