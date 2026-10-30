// Data model for the mock EHR + pharmacy services.

export type Schedule = "CII" | "CIII" | "CIV" | "CV" | null;

export interface RequiresRecentLab {
  readonly type: string; // e.g. "INR"
  readonly withinDays: number;
}

export interface Medication {
  readonly medId: string;
  readonly name: string;
  readonly isControlled: boolean;
  readonly schedule: Schedule;
  readonly lastFilledDate: string; // ISO date
  readonly daysSupply: number;
  refillsRemaining: number; // consumed by successful submission; restored by reset
  readonly rxExpirationDate: string; // ISO date
  readonly requiresRecentLab: RequiresRecentLab | null;
}

export interface Lab {
  readonly type: string;
  readonly value: string;
  readonly takenDate: string; // ISO date
}

export interface Patient {
  readonly patientId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly dob: string; // YYYY-MM-DD
  readonly phone: string; // full; phoneLast4 is derived
  readonly zip: string;
  currentPharmacyId: string | null; // mutable via PUT
  readonly medications: Medication[];
  readonly labs: Lab[];
}

export interface Pharmacy {
  readonly pharmacyId: string;
  readonly name: string;
  readonly address: string;
}

export interface Dataset {
  /** Simulated "now" — fixed per run so clinical-rule evaluation is deterministic. */
  readonly now: string; // ISO
  readonly patients: Patient[];
  readonly pharmacies: Pharmacy[];
}
