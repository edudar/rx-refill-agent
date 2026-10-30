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

export const ehrTimeSchema = z.object({
  now: z.iso.datetime({ offset: true }),
});

// Records that fail these schemas are rejected whole, so eligibility never runs
// on partial or malformed clinical data.
export const medicationSchema = z.object({
  medId: z.string().min(1),
  name: z.string().min(1),
  isControlled: z.boolean(),
  schedule: z.enum(["CII", "CIII", "CIV", "CV"]).nullable(),
  lastFilledDate: z.iso.date(),
  daysSupply: z.number().int().nonnegative(),
  refillsRemaining: z.number().int().nonnegative(),
  rxExpirationDate: z.iso.date(),
  requiresRecentLab: z
    .object({
      type: z.string().min(1),
      withinDays: z.number().int().nonnegative(),
    })
    .nullable(),
});

export const labResultSchema = z.object({
  type: z.string().min(1),
  value: z.union([z.string(), z.number()]),
  takenDate: z.iso.date(),
});

export const currentPharmacySchema = z
  .object({ pharmacyId: z.string().min(1), name: z.string().min(1) })
  .nullable();

export const pharmacyUpdateSchema = z.object({ ok: z.literal(true) });

export const refillSubmissionSchema = z.object({
  refillId: z.string().min(1),
  status: z.literal("submitted"),
});

export type PatientMatch = z.infer<typeof patientMatchSchema>;
export type PatientRecord = z.infer<typeof patientRecordSchema>;
export type Medication = z.infer<typeof medicationSchema>;
export type LabResult = z.infer<typeof labResultSchema>;
export type CurrentPharmacy = z.infer<typeof currentPharmacySchema>;
export type RefillSubmission = z.infer<typeof refillSubmissionSchema>;

export interface EhrClient {
  match(factors: IdentityFactors): Promise<PatientMatch>;
  getPatient(patientId: string): Promise<PatientRecord>;
  getTime(): Promise<string>;
  getMedications(patientId: string): Promise<Medication[]>;
  getLabs(patientId: string, type: string): Promise<LabResult[]>;
  getPharmacy(patientId: string): Promise<CurrentPharmacy>;
  setPharmacy(patientId: string, pharmacyId: string): Promise<void>;
  submitRefill(patientId: string, medId: string): Promise<RefillSubmission>;
}

// Authentication can find and read a patient but cannot reach records or writes.
export type PatientIdentityLookup = Pick<EhrClient, "match" | "getPatient">;
