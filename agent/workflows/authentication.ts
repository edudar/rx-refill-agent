import type {
  ConversationStep,
  StepResult,
} from "../contracts/conversation.js";
import type { EhrClient, PatientRecord } from "../contracts/ehr.js";
import {
  identityUpdateSchema,
  type IdentityExtractor,
  type IdentityUpdate,
} from "../contracts/identity-extraction.js";
import {
  generatedResponseSchema,
  type AuthenticationDecision,
  type ResponseGenerator,
} from "../contracts/response-generation.js";
import {
  completeIdentitySchema,
  identityFieldSchemas,
  type CompleteIdentity,
  type IdentityField,
} from "../domain/identity.js";
import {
  conversationBase,
  type AuthenticatingConversation,
} from "../domain/conversation.js";
import { normalizeDateOfBirth } from "../utils/date-of-birth.js";
import { responseFallback } from "./response-fallback.js";

const required = ["firstName", "lastName", "dob", "zip"] as const;
const verifiedMessage = "Thanks, your identity is verified.";

interface AuthenticationTurn {
  conversation: AuthenticatingConversation;
  received: IdentityField[];
  invalid: IdentityField[];
}

export function createAuthenticationFlow(options: {
  extractIdentity: IdentityExtractor;
  generateResponse: ResponseGenerator;
  ehr: EhrClient;
}): ConversationStep<AuthenticatingConversation> {
  return async (conversation, { text }) => {
    const turn: AuthenticationTurn = {
      conversation,
      received: [],
      invalid: [],
    };
    try {
      const update = identityUpdateSchema.parse(
        await options.extractIdentity({
          text,
          factors: { ...conversation.factors },
          lastPrompt: conversation.lastPrompt,
        }),
      );
      if (update.outOfScope) return redirectToRefill(turn);
      recordRefillIntent(conversation, update);
      applyIdentityUpdate(turn, update);
      const needed = neededIdentityFields(turn);
      const verification = needed.length
        ? { decision: requestIdentityFields(turn, needed) }
        : await verifyIdentity(turn, options.ehr);
      return "patient" in verification
        ? identityVerified(conversation, verification.patient)
        : respondToDecision(
            turn,
            verification.decision,
            options.generateResponse,
          );
    } catch {
      return respondToDecision(
        turn,
        decisionFor(turn, "verification_unavailable"),
        options.generateResponse,
      );
    }
  };
}

function decisionFor(
  { conversation, received, invalid }: AuthenticationTurn,
  action: AuthenticationDecision["action"],
  requestedFields: IdentityField[] = [],
): AuthenticationDecision {
  return {
    action,
    acceptedFields: Object.keys(conversation.factors) as IdentityField[],
    newlyReceivedFields: received,
    requestedFields,
    invalidFields: invalid,
    failedMatchAttempts: conversation.failedMatches,
    unansweredRequests: conversation.identityPrompt?.unansweredTurns ?? 0,
  };
}

async function respondToDecision(
  { conversation }: AuthenticationTurn,
  decision: AuthenticationDecision,
  generateResponse: ResponseGenerator,
): Promise<StepResult> {
  let text: string;
  try {
    const generated = await generateResponse({
      decision: structuredClone(decision),
      messages: conversation.history.map(({ from, text }) => ({ from, text })),
    });
    text = generatedResponseSchema.parse(generated).text;
  } catch {
    text = responseFallback(decision);
  }
  return {
    conversation:
      decision.action === "escalate"
        ? {
            ...conversationBase(conversation),
            phase: "ended",
            outcome: "escalated",
          }
        : conversation,
    messages: [{ from: "agent", text }],
    next: "reply",
  };
}

// Verification is stated by application code, never by the response model.
// The next phase continues this turn, using any refill already requested.
function identityVerified(
  conversation: AuthenticatingConversation,
  patient: PatientRecord,
): StepResult {
  return {
    conversation: {
      ...conversationBase(conversation),
      phase: "verified",
      patient,
    },
    messages: [{ from: "agent", text: verifiedMessage }],
    next: "continue",
  };
}

function redirectToRefill(turn: AuthenticationTurn): StepResult {
  const missing = missingIdentityFields(turn.conversation);
  const followUp = missing.length
    ? responseFallback(decisionFor(turn, "request_identity", missing))
    : "Let me know when you'd like to continue verifying your identity.";
  // Hard scope redirects never invoke generation or accept identity updates.
  return {
    conversation: turn.conversation,
    messages: [
      {
        from: "agent",
        text: `I can help with prescription refills and pharmacy changes. ${followUp}`,
      },
    ],
    next: "reply",
  };
}

function recordRefillIntent(
  conversation: AuthenticatingConversation,
  update: IdentityUpdate,
) {
  const mention = update.medicationMention?.trim().slice(0, 100);
  // The latest request wins, so a patient can change their mind before verifying.
  if (mention) conversation.pendingIntent = { medicationMention: mention };
}

function applyIdentityUpdate(turn: AuthenticationTurn, update: IdentityUpdate) {
  const { conversation, received, invalid } = turn;
  for (const field of Object.keys(identityFieldSchemas) as IdentityField[]) {
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
}

function missingIdentityFields(
  conversation: AuthenticatingConversation,
): IdentityField[] {
  return required.filter((field) => !conversation.factors[field]);
}

function neededIdentityFields(turn: AuthenticationTurn): IdentityField[] {
  return [
    ...new Set([...missingIdentityFields(turn.conversation), ...turn.invalid]),
  ];
}

function requestIdentityFields(
  turn: AuthenticationTurn,
  needed: IdentityField[],
) {
  const { conversation, received, invalid } = turn;
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
  return decisionFor(
    turn,
    invalid.length ? "request_correction" : "request_identity",
    needed,
  );
}

function identityFingerprint(conversation: AuthenticatingConversation) {
  return JSON.stringify(
    [...required, "phoneLast4" as const].map(
      (field) => conversation.factors[field] ?? null,
    ),
  );
}

function repeatFailedVerification(
  turn: AuthenticationTurn,
  factors: CompleteIdentity,
) {
  const { conversation } = turn;
  if (
    !factors.phoneLast4 &&
    conversation.identityPrompt?.fields.includes("phoneLast4")
  ) {
    conversation.identityPrompt.unansweredTurns++;
    return decisionFor(turn, "request_disambiguation", ["phoneLast4"]);
  }
  return decisionFor(turn, "verification_failed", [...required]);
}

function recordFailedMatch(
  turn: AuthenticationTurn,
  count: number,
  fingerprint: string,
) {
  const { conversation } = turn;
  conversation.failedMatches++;
  conversation.lastFailedFactors = fingerprint;
  if (conversation.failedMatches >= 3) return decisionFor(turn, "escalate");
  if (count > 1 && !conversation.factors.phoneLast4) {
    conversation.identityPrompt = {
      fields: ["phoneLast4"],
      unansweredTurns: 0,
    };
    return decisionFor(turn, "request_disambiguation", ["phoneLast4"]);
  }
  return decisionFor(turn, "verification_failed", [...required]);
}

type Verification =
  { patient: PatientRecord } | { decision: AuthenticationDecision };

async function verifyIdentity(
  turn: AuthenticationTurn,
  ehr: EhrClient,
): Promise<Verification> {
  const { conversation } = turn;
  const factors = completeIdentitySchema.parse(conversation.factors);
  const fingerprint = identityFingerprint(conversation);
  if (fingerprint === conversation.lastFailedFactors)
    return { decision: repeatFailedVerification(turn, factors) };
  delete conversation.identityPrompt;
  const match = await ehr.match(factors);
  if (match.count !== 1 || !match.patientId)
    return { decision: recordFailedMatch(turn, match.count, fingerprint) };
  const patient = await ehr.getPatient(match.patientId);
  if (!matchesFactors(patient, factors))
    throw new Error("Patient record does not match supplied identity");
  return { patient };
}

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
