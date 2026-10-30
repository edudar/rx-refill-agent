// What a failed request says about whether the service acted on it:
// rejected (4xx) was refused; every other kind may or may not have been applied.
export type ServiceFailureKind =
  "rejected" | "unavailable" | "no_response" | "invalid_response";

export class ServiceRequestError extends Error {
  constructor(
    readonly kind: ServiceFailureKind,
    readonly status?: number,
  ) {
    // Messages never include response bodies, which may carry patient data.
    super(`Service request failed (${kind}${status ? ` ${status}` : ""})`);
    this.name = "ServiceRequestError";
  }
}
