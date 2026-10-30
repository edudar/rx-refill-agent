import { z } from "zod";

// Proposals only: application code resolves names against the record and the
// directory and decides whether anything is confirmed.
export const refillUnderstandingSchema = z.object({
  outOfScope: z.boolean(),
  intent: z.enum(["confirm", "decline", "change_pharmacy", "cancel", "other"]),
  medicationMention: z.string().nullable(),
  optionNumber: z.number().int().nullable(),
  pharmacyName: z.string().nullable(),
  pharmacyLocation: z.string().nullable(),
  keepCurrentPharmacy: z.boolean(),
});

export type RefillUnderstanding = z.infer<typeof refillUnderstandingSchema>;
export type RefillQuestion =
  "which_medication" | "which_pharmacy" | "confirm_refill" | "anything_else";
export interface RefillInterpretationInput {
  text: string;
  question: RefillQuestion;
  lastPrompt: string;
}
export type RefillInterpreter = (
  input: RefillInterpretationInput,
) => Promise<RefillUnderstanding>;
