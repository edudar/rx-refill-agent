import type { EhrConfig } from "./config.js";
import {
  patientMatchSchema,
  patientRecordSchema,
  type EhrClient,
} from "./contracts/ehr.js";

export function createEhrClient(
  options: EhrConfig & { fetch?: typeof globalThis.fetch },
): EhrClient {
  const base = new URL(options.baseUrl);
  if (!["http:", "https:"].includes(base.protocol))
    throw new Error("EHR_BASE_URL must be an HTTP(S) URL");
  const request = async (
    path: string,
    init?: RequestInit,
  ): Promise<unknown> => {
    const response = await (options.fetch ?? globalThis.fetch)(
      new URL(path, base),
      {
        ...init,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("EHR request failed");
    return response.json();
  };
  return {
    async match(factors) {
      return patientMatchSchema.parse(
        await request("/ehr/patients:match", {
          method: "POST",
          body: JSON.stringify({ factors }),
        }),
      );
    },
    async getPatient(patientId) {
      const patient = patientRecordSchema.parse(
        await request(`/ehr/patients/${encodeURIComponent(patientId)}`),
      );
      if (patient.patientId !== patientId)
        throw new Error("EHR returned a different patient");
      return patient;
    },
  };
}
