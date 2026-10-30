// Sample development data — small, illustrative, and clearly synthetic. Your agent should work
// for any patients/records of this shape, not just these specific ones.
//
// Simulated "now" is 2026-09-01T12:00:00Z (see GET /ehr/time); all dates below are relative to it.

import type { Dataset } from "./types";

export const devDataset: Dataset = {
  now: "2026-09-01T12:00:00Z",
  pharmacies: [
    { pharmacyId: "ph_001", name: "Bay Pharmacy", address: "123 Market St, San Francisco, CA 94103" },
    { pharmacyId: "ph_002", name: "Mission Rx", address: "456 Valencia St, San Francisco, CA 94110" },
    { pharmacyId: "ph_003", name: "Sunset Drugs", address: "789 Irving St, San Francisco, CA 94122" },
    { pharmacyId: "ph_004", name: "Marina Health Pharmacy", address: "321 Chestnut St, San Francisco, CA 94123" },
  ],
  patients: [
    // Happy path: non-controlled, refills remaining, current Rx.
    {
      patientId: "pat_001", firstName: "Alice", lastName: "Nguyen", dob: "1988-03-12",
      phone: "415-555-1234", zip: "94107", currentPharmacyId: "ph_001", labs: [],
      medications: [{
        medId: "med_a1", name: "Lisinopril 10mg", isControlled: false, schedule: null,
        lastFilledDate: "2026-08-05", daysSupply: 90, refillsRemaining: 3,
        rxExpirationDate: "2027-03-01", requiresRecentLab: null,
      }],
    },
    // R1: Schedule II — not refillable via agent; escalate.
    {
      patientId: "pat_002", firstName: "Bob", lastName: "Alvarez", dob: "1975-07-30",
      phone: "415-555-5678", zip: "94110", currentPharmacyId: "ph_002", labs: [],
      medications: [{
        medId: "med_b1", name: "Methylphenidate 20mg", isControlled: true, schedule: "CII",
        lastFilledDate: "2026-08-20", daysSupply: 30, refillsRemaining: 0,
        rxExpirationDate: "2026-11-01", requiresRecentLab: null,
      }],
    },
    // R2: no refills left AND expired Rx — escalate to prescriber.
    {
      patientId: "pat_003", firstName: "Carla", lastName: "Diaz", dob: "1990-11-05",
      phone: "415-555-9012", zip: "94103", currentPharmacyId: "ph_001", labs: [],
      medications: [{
        medId: "med_c1", name: "Atorvastatin 40mg", isControlled: false, schedule: null,
        lastFilledDate: "2026-05-15", daysSupply: 90, refillsRemaining: 0,
        rxExpirationDate: "2026-06-01", requiresRecentLab: null,
      }],
    },
    // R3: controlled (CIV) requested ~25 days early -> deny (too early). Plus a non-controlled
    // med that refills fine (look-alike).
    {
      patientId: "pat_004", firstName: "David", lastName: "Kim", dob: "1982-02-20",
      phone: "415-555-3456", zip: "94112", currentPharmacyId: "ph_003", labs: [],
      medications: [
        {
          medId: "med_d1", name: "Alprazolam 0.5mg", isControlled: true, schedule: "CIV",
          lastFilledDate: "2026-08-27", daysSupply: 30, refillsRemaining: 2,
          rxExpirationDate: "2027-01-01", requiresRecentLab: null,
        },
        {
          medId: "med_d2", name: "Metformin 500mg", isControlled: false, schedule: null,
          lastFilledDate: "2026-08-01", daysSupply: 90, refillsRemaining: 5,
          rxExpirationDate: "2027-06-01", requiresRecentLab: null,
        },
      ],
    },
    // R4: requires a recent INR; last INR is 63 days old (> 30) -> hold/advise.
    {
      patientId: "pat_005", firstName: "Emma", lastName: "Rossi", dob: "1969-09-09",
      phone: "415-555-7788", zip: "94118", currentPharmacyId: "ph_002",
      labs: [{ type: "INR", value: "2.4", takenDate: "2026-06-30" }],
      medications: [{
        medId: "med_e1", name: "Warfarin 5mg", isControlled: false, schedule: null,
        lastFilledDate: "2026-08-10", daysSupply: 30, refillsRemaining: 4,
        rxExpirationDate: "2027-02-01", requiresRecentLab: { type: "INR", withinDays: 30 },
      }],
    },
    // R3 look-alike: controlled (CIV) 1 day before supply runs out -> within 2-day window, eligible.
    {
      patientId: "pat_006", firstName: "Frank", lastName: "Miller", dob: "1960-04-04",
      phone: "415-555-2020", zip: "94109", currentPharmacyId: "ph_001", labs: [],
      medications: [{
        medId: "med_f1", name: "Lorazepam 1mg", isControlled: true, schedule: "CIV",
        lastFilledDate: "2026-08-03", daysSupply: 30, refillsRemaining: 3,
        rxExpirationDate: "2027-01-01", requiresRecentLab: null,
      }],
    },
    // Two patients share a name + date of birth; they differ on phone/zip.
    {
      patientId: "pat_007", firstName: "John", lastName: "Smith", dob: "1980-01-01",
      phone: "415-555-1111", zip: "94001", currentPharmacyId: "ph_001", labs: [],
      medications: [{
        medId: "med_g1", name: "Amlodipine 5mg", isControlled: false, schedule: null,
        lastFilledDate: "2026-08-12", daysSupply: 90, refillsRemaining: 2,
        rxExpirationDate: "2027-05-01", requiresRecentLab: null,
      }],
    },
    {
      patientId: "pat_008", firstName: "John", lastName: "Smith", dob: "1980-01-01",
      phone: "415-555-2222", zip: "94002", currentPharmacyId: "ph_002", labs: [],
      medications: [{
        medId: "med_h1", name: "Omeprazole 20mg", isControlled: false, schedule: null,
        lastFilledDate: "2026-08-18", daysSupply: 90, refillsRemaining: 1,
        rxExpirationDate: "2027-04-01", requiresRecentLab: null,
      }],
    },
  ],
};
