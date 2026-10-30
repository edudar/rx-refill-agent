import type {
  AgentReply,
  AgentReplyState,
  ConversationStep,
} from "./contracts/conversation.js";
import type { EhrClient, PatientRecord } from "./contracts/ehr.js";
import {
  identityUpdateSchema,
  type IdentityExtractor,
} from "./contracts/identity-extraction.js";
import {
  completeIdentitySchema,
  identityFieldSchemas,
  type CompleteIdentity,
  type IdentityFactors,
} from "./domain/identity.js";
import { normalizeDateOfBirth } from "./domain/date-of-birth.js";
import { createMissingIdentityPrompt } from "./authentication-prompts.js";

const required = ["firstName", "lastName", "dob", "zip"] as const;

function matchesFactors(patient: PatientRecord, factors: CompleteIdentity) {
  return (
    patient.firstName.toLowerCase() === factors.firstName.toLowerCase() &&
    patient.lastName.toLowerCase() === factors.lastName.toLowerCase() &&
    patient.dob === factors.dob &&
    patient.zip === factors.zip &&
    (!factors.phoneLast4 ||
      patient.phone.replace(/\D/g, "").slice(-4) === factors.phoneLast4)
  );
}

export function createAuthenticationFlow(options: {
  extractIdentity: IdentityExtractor;
  ehr: EhrClient;
}): ConversationStep {
  return async (conversation, text) => {
    const reply = (
      message: string,
      state: AgentReplyState = "in_progress",
    ): AgentReply => ({
      messages: [{ from: "agent", text: message }],
      state,
    });
    try {
      const update = identityUpdateSchema.parse(
        await options.extractIdentity({
          text,
          factors: { ...conversation.factors },
          lastPrompt: conversation.lastPrompt,
        }),
      );
      // The model proposes facts; it cannot mark this conversation authenticated.
      const invalid: (keyof IdentityFactors)[] = [];
      const received: (keyof IdentityFactors)[] = [];
      for (const field of Object.keys(
        identityFieldSchemas,
      ) as (keyof IdentityFactors)[]) {
        const value = update[field];
        if (update.outOfScope) continue;
        if (value === null) continue;
        const parsed = identityFieldSchemas[field].safeParse(
          field === "dob" ? normalizeDateOfBirth(value) : value,
        );
        if (parsed.success) {
          if (conversation.factors[field] !== parsed.data) received.push(field);
          conversation.factors[field] = parsed.data;
        } else {
          delete conversation.factors[field];
          invalid.push(field);
        }
      }
      const missing = required.filter((field) => !conversation.factors[field]);
      const needed = [...new Set([...missing, ...invalid])];
      if (needed.length)
        return reply(
          createMissingIdentityPrompt({
            conversation,
            needed,
            received,
            invalid,
            topic: update.topic,
            outOfScope: update.outOfScope,
          }),
        );
      if (update.outOfScope)
        return reply(
          "I can help with prescription refills and pharmacy changes. Let me know when you'd like to continue verifying your identity.",
        );
      delete conversation.identityPrompt;
      const factors = completeIdentitySchema.parse(conversation.factors);
      const fingerprint = JSON.stringify(
        [...required, "phoneLast4" as const].map(
          (field) => conversation.factors[field] ?? null,
        ),
      );
      if (fingerprint === conversation.lastFailedFactors)
        return reply(
          "I couldn't verify those details. Please check and correct your full name, date of birth, or ZIP code. You can also provide or correct your phone's last four digits.",
        );
      const match = await options.ehr.match(factors);
      if (match.count !== 1 || !match.patientId) {
        conversation.failedMatches++;
        conversation.lastFailedFactors = fingerprint;
        if (conversation.failedMatches >= 3) {
          return reply(
            "I couldn't verify your identity after several attempts. Please contact your care team for help.",
            "escalated",
          );
        }
        if (match.count > 1 && !conversation.factors.phoneLast4)
          return reply(
            "I need one more detail to verify your identity. What are the last four digits of your phone number?",
          );
        return reply(
          "I couldn't verify those details. Please check your full name, date of birth, and ZIP code, and send any corrections.",
        );
      }
      const patient = await options.ehr.getPatient(match.patientId);
      if (!matchesFactors(patient, factors))
        throw new Error("Patient record does not match supplied identity");
      conversation.patient = patient;
      return reply(
        "Thanks, your identity is verified. Which prescription would you like to refill?",
      );
    } catch {
      // Do not expose upstream responses, credentials, or demographic information.
      return reply(
        "I'm having trouble verifying your identity right now. Please try again in a moment.",
      );
    }
  };
}
