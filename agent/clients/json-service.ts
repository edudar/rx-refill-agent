import type { z } from "zod";
import { ServiceRequestError } from "../contracts/service-errors.js";

const REQUEST_TIMEOUT_MS = 5_000;

export interface JsonServiceOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

// Authenticated JSON requests whose failures say whether the service could have
// acted: a 4xx was refused; 5xx, no response, or an unreadable body may hide one.
export function createJsonService(options: JsonServiceOptions) {
  const base = new URL(options.baseUrl);
  if (!["http:", "https:"].includes(base.protocol))
    throw new Error("Service base URLs must be HTTP(S)");
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
      throw new ServiceRequestError("no_response");
    }
    if (!response.ok)
      throw new ServiceRequestError(
        response.status < 500 ? "rejected" : "unavailable",
        response.status,
      );
    try {
      return schema.parse(await response.json());
    } catch {
      throw new ServiceRequestError("invalid_response", response.status);
    }
  };
}
