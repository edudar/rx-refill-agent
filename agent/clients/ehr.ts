import type { z } from "zod";
import type { EhrConfig } from "../config.js";
import {
  currentPharmacySchema,
  EhrRequestError,
  ehrTimeSchema,
  labResultSchema,
  medicationSchema,
  patientMatchSchema,
  patientRecordSchema,
  pharmacyUpdateSchema,
  refillSubmissionSchema,
  type EhrClient,
} from "../contracts/ehr.js";

const REQUEST_TIMEOUT_MS = 5_000;

export function createEhrClient(
  options: EhrConfig & { fetch?: typeof globalThis.fetch },
): EhrClient {
  const request = createEhrRequest(options);
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
        throw new EhrRequestError("invalid_response");
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

function createEhrRequest(
  options: EhrConfig & { fetch?: typeof globalThis.fetch },
) {
  const base = new URL(options.baseUrl);
  if (!["http:", "https:"].includes(base.protocol))
    throw new Error("EHR_BASE_URL must be an HTTP(S) URL");
  return async <T>(
    schema: z.ZodType<T>,
    path: string,
    init?: RequestInit,
  ): Promise<T> => {
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(
        new URL(path, base),
        {
          ...init,
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: "error",
        },
      );
    } catch {
      throw new EhrRequestError("no_response");
    }
    if (!response.ok)
      throw new EhrRequestError(
        response.status < 500 ? "rejected" : "unavailable",
        response.status,
      );
    try {
      return schema.parse(await response.json());
    } catch {
      throw new EhrRequestError("invalid_response", response.status);
    }
  };
}
