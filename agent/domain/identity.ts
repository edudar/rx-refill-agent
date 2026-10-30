import { z } from "zod";

export const identityFieldSchemas = {
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  dob: z.iso.date(),
  phoneLast4: z.string().regex(/^\d{4}$/),
  zip: z.string().regex(/^\d{5}$/),
};

export const identityFactorsSchema = z.object(identityFieldSchemas).partial();
export const completeIdentitySchema = identityFactorsSchema.required({
  firstName: true,
  lastName: true,
  dob: true,
  zip: true,
});

export type IdentityFactors = z.infer<typeof identityFactorsSchema>;
export type CompleteIdentity = z.infer<typeof completeIdentitySchema>;
