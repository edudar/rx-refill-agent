import type { AuthenticationDecision } from "../contracts/response-generation.js";
import type { IdentityField } from "../domain/identity.js";
import { formatDate } from "../utils/calendar-date.js";

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });
const alternatives = new Intl.ListFormat("en", { type: "disjunction" });

// "full name, date of birth, and five-digit ZIP code"
export function describeFields(
  fields: readonly IdentityField[],
  { writtenMonth = false } = {},
) {
  const labels: Record<IdentityField, string> = {
    firstName: fields.includes("lastName") ? "full name" : "first name",
    lastName: "last name",
    dob: writtenMonth
      ? "date of birth with the month written out (for example, March 12, 1988)"
      : "date of birth",
    zip: "five-digit ZIP code",
    phoneLast4: "phone number's last four digits",
  };
  return listFormat.format(
    fields
      .filter((field) => field !== "lastName" || !fields.includes("firstName"))
      .map((field) => labels[field]),
  );
}

// A numeric date that reads two ways is confirmed by offering both readings.
export function dateOfBirthChoice(
  readings: readonly string[],
  otherFields: readonly IdentityField[],
) {
  const also = otherFields.length
    ? ` I'll also need your ${describeFields(otherFields)}.`
    : "";
  return `Just to check your date of birth: did you mean ${alternatives.format(readings.map(formatDate))}?${also}`;
}

// Fixed handoffs when verification cannot continue for reasons other than
// three failed matches.
export const identityEscalation = {
  unanswered: (fields: readonly IdentityField[]) =>
    `I can't verify your identity without your ${describeFields(fields)}, so I'm unable to continue with this request here. Please contact your care team for help.`,
  unverified:
    "I couldn't verify your identity with the details provided, so I'm unable to continue with this request here. Please contact your care team for help.",
  unavailable:
    "I still can't verify your identity because our systems are unavailable, so I'm unable to continue with this request here. Please contact your care team for help.",
  // Reply to any message after verification has ended the conversation.
  afterwards:
    "I can't continue with this request here. Please contact your care team for help with your refill.",
};

// Used when response generation fails, and always for escalation, whose
// wording is fixed; other normal phrasing belongs to the model.
export function responseFallback(decision: AuthenticationDecision): string {
  switch (decision.action) {
    case "escalate":
      return "I couldn't verify your identity. Please contact your care team for help.";
    case "verification_unavailable":
      return "I'm having trouble verifying your identity right now. Please try again in a moment.";
    case "verification_failed":
      return "I couldn't verify those details. Please check your full name, date of birth, and ZIP code, and send any corrections.";
    default:
      return `To verify your identity, please share your ${describeFields(
        decision.requestedFields,
        { writtenMonth: decision.invalidFields.includes("dob") },
      )}.`;
  }
}
