import { z } from "zod";
import { identityFieldSchema } from "../domain/identity.js";
import type { ConversationMessage } from "./conversation.js";

// This decision is produced by application code, never by the response model.
export const authenticationDecisionSchema = z.object({
  action: z.enum([
    "request_identity",
    "request_correction",
    "request_disambiguation",
    "verification_failed",
    "verification_unavailable",
    "escalate",
  ]),
  acceptedFields: z.array(identityFieldSchema),
  newlyReceivedFields: z.array(identityFieldSchema),
  requestedFields: z.array(identityFieldSchema),
  invalidFields: z.array(identityFieldSchema),
  failedMatchAttempts: z.number().int().nonnegative(),
  unansweredRequests: z.number().int().nonnegative(),
});
export type AuthenticationDecision = z.infer<
  typeof authenticationDecisionSchema
>;

export const generatedResponseSchema = z
  .object({ text: z.string().trim().min(1).max(1_200) })
  .strict();
export type GeneratedResponse = z.infer<typeof generatedResponseSchema>;
export interface ResponseGenerationInput {
  decision: AuthenticationDecision;
  messages: ConversationMessage[];
}
export type ResponseGenerator = (
  input: ResponseGenerationInput,
) => Promise<GeneratedResponse>;
