import { z } from "zod";
import type { IdentityFactors } from "../domain/identity.js";

export const patientMatchSchema = z
  .object({
    count: z.number().int().nonnegative(),
    patientId: z.string().min(1).nullable(),
  })
  .refine((match) => (match.count === 1) === (match.patientId !== null));

export const patientRecordSchema = z.object({
  patientId: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  dob: z.iso.date(),
  phone: z.string().min(4),
  zip: z.string().regex(/^\d{5}$/),
});

export type PatientMatch = z.infer<typeof patientMatchSchema>;
export type PatientRecord = z.infer<typeof patientRecordSchema>;
export interface EhrClient {
  match(factors: IdentityFactors): Promise<PatientMatch>;
  getPatient(patientId: string): Promise<PatientRecord>;
}
