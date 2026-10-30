import type { Patient } from "./types.js";
import type { MockRequest, MockResponse } from "./http.js";
import type { MockState } from "./state.js";
import { submitRefill } from "./state.js";
import { refillRejection } from "./refill-rules.js";

export function handleEhrRequest(
  request: MockRequest,
  state: MockState,
): MockResponse | undefined {
  const { path, method, segments } = request;
  if (path === "/ehr/time" && method === "GET")
    return { status: 200, body: { now: state.now } };
  if (path === "/ehr/patients:match" && method === "POST")
    return matchPatient(request, state);
  if (segments[0] === "ehr" && segments[1] === "patients" && segments[2]) {
    const patient = state.data.patients.find(
      (patient) => patient.patientId === segments[2],
    );
    if (!patient) return { status: 404, body: { error: "patient not found" } };
    return handlePatientRequest(request, state, patient);
  }
}

function matchesFactor(patient: Patient, field: string, value: unknown) {
  const text = String(value);
  switch (field) {
    case "firstName":
      return patient.firstName.toLowerCase() === text.toLowerCase();
    case "lastName":
      return patient.lastName.toLowerCase() === text.toLowerCase();
    case "dob":
      return patient.dob === text;
    case "phoneLast4":
      return patient.phone.replace(/\D/g, "").slice(-4) === text;
    case "zip":
      return patient.zip === text;
    default:
      return false;
  }
}

function matchPatient(
  { body }: MockRequest,
  { data }: MockState,
): MockResponse {
  if (body === null) return { status: 400, body: { error: "invalid json" } };
  const provided = Object.entries(body?.factors ?? {}).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  const matches = data.patients.filter((patient) =>
    provided.every(([field, value]) => matchesFactor(patient, field, value)),
  );
  return {
    status: 200,
    body: {
      count: matches.length,
      patientId: matches.length === 1 ? matches[0].patientId : null,
    },
  };
}

function patientDemographics(patient: Patient) {
  const { patientId, firstName, lastName, dob, phone, zip } = patient;
  return { patientId, firstName, lastName, dob, phone, zip };
}

function handlePatientRequest(
  request: MockRequest,
  state: MockState,
  patient: Patient,
): MockResponse | undefined {
  const { segments, method, query } = request;
  if (segments.length === 3 && method === "GET")
    return { status: 200, body: patientDemographics(patient) };
  if (segments.length !== 4) return;
  if (segments[3] === "medications" && method === "GET")
    return { status: 200, body: patient.medications };
  if (segments[3] === "labs" && method === "GET")
    return { status: 200, body: patientLabs(patient, query.get("type")) };
  if (segments[3] === "pharmacy")
    return handlePatientPharmacy(request, state, patient);
  if (segments[3] === "refills" && method === "POST")
    return handlePatientRefill(request, state, patient);
}

function patientLabs(patient: Patient, type: string | null) {
  return type
    ? patient.labs.filter(
        (lab) => lab.type.toLowerCase() === type.toLowerCase(),
      )
    : patient.labs;
}

function handlePatientPharmacy(
  { method, body }: MockRequest,
  { data }: MockState,
  patient: Patient,
): MockResponse | undefined {
  if (method === "GET") {
    const pharmacy = data.pharmacies.find(
      (pharmacy) => pharmacy.pharmacyId === patient.currentPharmacyId,
    );
    return {
      status: 200,
      body: pharmacy
        ? { pharmacyId: pharmacy.pharmacyId, name: pharmacy.name }
        : null,
    };
  }
  if (method === "PUT") {
    if (body === null || !body.pharmacyId)
      return { status: 400, body: { error: "pharmacyId required" } };
    if (
      !data.pharmacies.some(
        (pharmacy) => pharmacy.pharmacyId === body.pharmacyId,
      )
    )
      return { status: 404, body: { error: "pharmacy not found" } };
    patient.currentPharmacyId = body.pharmacyId;
    return { status: 200, body: { ok: true } };
  }
}

function handlePatientRefill(
  { body }: MockRequest,
  state: MockState,
  patient: Patient,
): MockResponse {
  if (body === null || !body.medId)
    return { status: 400, body: { error: "medId required" } };
  const medication = patient.medications.find(
    (medication) => medication.medId === body.medId,
  );
  if (!medication)
    return { status: 404, body: { error: "medication not found" } };
  const error = refillRejection(medication, patient.labs, state.now);
  if (error) return { status: 409, body: { error } };
  return { status: 200, body: submitRefill(state, medication) };
}
