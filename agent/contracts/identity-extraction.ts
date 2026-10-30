import { z } from "zod";
import type { IdentityFactors } from "../domain/identity.js";

// Raw proposals may be incomplete or invalid; domain validators decide what to keep.
export const identityUpdateSchema = z.object({
  outOfScope: z.boolean(),
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
