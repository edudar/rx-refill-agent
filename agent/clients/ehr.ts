import type { EhrConfig } from "../config.js";
import {
  currentPharmacySchema,
  ehrTimeSchema,
  labResultSchema,
  medicationSchema,
  patientMatchSchema,
  patientRecordSchema,
  pharmacyUpdateSchema,
  refillSubmissionSchema,
  type EhrClient,
} from "../contracts/ehr.js";
import { ServiceRequestError } from "../contracts/service-errors.js";
import { createJsonService } from "./json-service.js";

export function createEhrClient(
  options: EhrConfig & { fetch?: typeof globalThis.fetch },
): EhrClient {
  const request = createJsonService(options);
  const patientPath = (patientId: string, resource = "") =>
    `/ehr/patients/${encodeURIComponent(patientId)}${resource && `/${resource}`}`;
  return {
    async match(factors) {
      return request(patientMatchSchema, "/ehr/patients:match", {
        method: "POST",
        body: JSON.stringify({ factors }),
      });
    },
    async getPatient(patientId) {
      const patient = await request(
        patientRecordSchema,
        patientPath(patientId),
      );
      if (patient.patientId !== patientId)
        throw new ServiceRequestError("invalid_response");
      return patient;
    },
    async getTime() {
      return (await request(ehrTimeSchema, "/ehr/time")).now;
    },
    async getMedications(patientId) {
      return request(
        medicationSchema.array(),
        patientPath(patientId, "medications"),
      );
    },
    async getLabs(patientId, type) {
      return request(
        labResultSchema.array(),
        `${patientPath(patientId, "labs")}?${new URLSearchParams({ type })}`,
      );
    },
    async getPharmacy(patientId) {
      return request(currentPharmacySchema, patientPath(patientId, "pharmacy"));
    },
    async setPharmacy(patientId, pharmacyId) {
      await request(pharmacyUpdateSchema, patientPath(patientId, "pharmacy"), {
        method: "PUT",
        body: JSON.stringify({ pharmacyId }),
      });
    },
    async submitRefill(patientId, medId) {
      return request(
        refillSubmissionSchema,
        patientPath(patientId, "refills"),
        {
          method: "POST",
          body: JSON.stringify({ medId }),
        },
      );
    },
  };
}
