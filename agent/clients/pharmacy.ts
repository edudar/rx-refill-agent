import type { PharmacyConfig } from "../config.js";
import {
  pharmacyListingSchema,
  type PharmacyDirectory,
} from "../contracts/pharmacy.js";
import { createJsonService } from "./json-service.js";

export function createPharmacyDirectory(
  options: PharmacyConfig & { fetch?: typeof globalThis.fetch },
): PharmacyDirectory {
  const request = createJsonService(options);
  return {
    search(query) {
      return request(
        pharmacyListingSchema.array(),
        `/pharmacy/directory?${new URLSearchParams({ q: query })}`,
      );
    },
  };
}
