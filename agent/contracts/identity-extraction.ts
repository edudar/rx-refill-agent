import { z } from "zod";
import type { IdentityFactors } from "../domain/identity.js";

// Raw proposals may be incomplete or invalid; domain validators decide what to keep.
export const identityMessageTopicSchema = z.enum([
  "identity",
  "pharmacy",
  "verification",
  "refill",
  "other",
]);
export type IdentityMessageTopic = z.infer<typeof identityMessageTopicSchema>;

export const identityUpdateSchema = z.object({
  outOfScope: z.boolean(),
  topic: identityMessageTopicSchema,
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  dob: z.string().nullable(),
  phoneLast4: z.string().nullable(),
  zip: z.string().nullable(),
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
