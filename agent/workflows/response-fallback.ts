import type { AuthenticationDecision } from "../contracts/response-generation.js";

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
    default: {
      const fields = decision.requestedFields;
      const labels = {
        firstName: fields.includes("lastName") ? "full name" : "first name",
        lastName: "last name",
        dob: decision.invalidFields.includes("dob")
          ? "date of birth with the month written out (for example, March 12, 1988)"
          : "date of birth",
        zip: "five-digit ZIP code",
        phoneLast4: "phone number's last four digits",
      };
      const names = fields
        .filter(
          (field) => field !== "lastName" || !fields.includes("firstName"),
        )
        .map((field) => labels[field]);
      return `To verify your identity, please share your ${new Intl.ListFormat("en", { type: "conjunction" }).format(names)}.`;
    }
  }
}
