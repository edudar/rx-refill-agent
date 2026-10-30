import { readFileSync } from "node:fs";
import type { Dataset, Patient } from "../mock/types.js";

// Extended copy of the starter mock dataset (serve it with `npm run mock:conformance`).
// These are test inputs/expectations, never a source of patient data for the agent.
const dataset: Dataset = JSON.parse(
  readFileSync(new URL("./dataset.json", import.meta.url), "utf8"),
);

export const expectedMockFixture = {
  now: dataset.now,
  patientIds: dataset.patients.map((patient) => patient.patientId),
};

export function patientFixture(id: string): Patient {
  const patient = dataset.patients.find((patient) => patient.patientId === id);
  if (!patient) throw new Error(`Missing conformance fixture ${id}`);
  return structuredClone(patient);
}

export function identityMessage(patient: Patient, dob = patient.dob) {
  return `${patient.firstName} ${patient.lastName}, DOB ${dob}, ZIP ${patient.zip}.`;
}

export function pharmacyName(id: string | null) {
  return (
    dataset.pharmacies.find((pharmacy) => pharmacy.pharmacyId === id)?.name ??
    "no pharmacy"
  );
}
