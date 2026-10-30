import type { AgentReply, ConversationStep } from "./contracts/conversation.js";
import type { EhrClient, PatientRecord } from "./contracts/ehr.js";
import {
  identityUpdateSchema,
  type IdentityExtractor,
} from "./contracts/identity-extraction.js";
import {
  generatedResponseSchema,
  type AuthenticationDecision,
  type ResponseGenerator,
} from "./contracts/response-generation.js";
import {
  completeIdentitySchema,
  identityFieldSchemas,
  type CompleteIdentity,
  type IdentityField,
} from "./domain/identity.js";
import { normalizeDateOfBirth } from "./domain/date-of-birth.js";
import { responseFallback } from "./response-fallback.js";

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
  generateResponse: ResponseGenerator;
  ehr: EhrClient;
}): ConversationStep {
  return async (conversation, text) => {
    const received: IdentityField[] = [];
    const invalid: IdentityField[] = [];
    const decisionFor = (
      action: AuthenticationDecision["action"],
      requestedFields: IdentityField[] = [],
    ): AuthenticationDecision => ({
      action,
      acceptedFields: Object.keys(conversation.factors) as IdentityField[],
      newlyReceivedFields: received,
      requestedFields,
      invalidFields: invalid,
      failedMatchAttempts: conversation.failedMatches,
      unansweredRequests: conversation.identityPrompt?.unansweredTurns ?? 0,
    });
    const respond = async (
      action: AuthenticationDecision["action"],
      requestedFields: IdentityField[] = [],
    ): Promise<AgentReply> => {
      const decision = decisionFor(action, requestedFields);
      const state = action === "escalate" ? "escalated" : "in_progress";
      let responseText: string;
      try {
        const generated = await options.generateResponse({
          decision: structuredClone(decision),
          messages: conversation.history.map(({ from, text }) => ({
            from,
            text,
          })),
        });
        responseText = generatedResponseSchema.parse(generated).text;
      } catch {
        responseText = responseFallback(decision);
      }
      return { messages: [{ from: "agent", text: responseText }], state };
    };

    try {
      const update = identityUpdateSchema.parse(
        await options.extractIdentity({
          text,
          factors: { ...conversation.factors },
          lastPrompt: conversation.lastPrompt,
        }),
      );
      // Hard scope redirects never invoke the response generator or change identity.
      if (update.outOfScope) {
        const missing = required.filter(
          (field) => !conversation.factors[field],
        );
        const followUp = missing.length
          ? responseFallback(decisionFor("request_identity", missing))
          : "Let me know when you'd like to continue verifying your identity.";
        return {
          messages: [
            {
              from: "agent",
              text: `I can help with prescription refills and pharmacy changes. ${followUp}`,
            },
          ],
          state: "in_progress",
        };
      }
      for (const field of Object.keys(
        identityFieldSchemas,
      ) as IdentityField[]) {
        const value = update[field];
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
      const needed = [...new Set<IdentityField>([...missing, ...invalid])];
      if (needed.length) {
        const previous = conversation.identityPrompt;
        const sameRequest =
          previous?.fields.length === needed.length &&
          needed.every((field) => previous.fields.includes(field));
        conversation.identityPrompt = {
          fields: needed,
          unansweredTurns:
            sameRequest && !received.length && !invalid.length
              ? previous.unansweredTurns + 1
              : 0,
        };
        return respond(
          invalid.length ? "request_correction" : "request_identity",
          needed,
        );
      }

      const factors = completeIdentitySchema.parse(conversation.factors);
      const fingerprint = JSON.stringify(
        [...required, "phoneLast4" as const].map(
          (field) => conversation.factors[field] ?? null,
        ),
      );
      if (fingerprint === conversation.lastFailedFactors) {
        if (
          !factors.phoneLast4 &&
          conversation.identityPrompt?.fields.includes("phoneLast4")
        ) {
          conversation.identityPrompt.unansweredTurns++;
          return respond("request_disambiguation", ["phoneLast4"]);
        }
        return respond("verification_failed", [...required]);
      }
      delete conversation.identityPrompt;
      const match = await options.ehr.match(factors);
      if (match.count !== 1 || !match.patientId) {
        conversation.failedMatches++;
        conversation.lastFailedFactors = fingerprint;
        if (conversation.failedMatches >= 3) return respond("escalate");
        if (match.count > 1 && !factors.phoneLast4) {
          conversation.identityPrompt = {
            fields: ["phoneLast4"],
            unansweredTurns: 0,
          };
          return respond("request_disambiguation", ["phoneLast4"]);
        }
        return respond("verification_failed", [...required]);
      }
      const patient = await options.ehr.getPatient(match.patientId);
      if (!matchesFactors(patient, factors))
        throw new Error("Patient record does not match supplied identity");
      conversation.patient = patient;
      return respond("identity_verified");
    } catch {
      return respond("verification_unavailable");
    }
  };
}
