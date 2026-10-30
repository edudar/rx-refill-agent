import type {
  ConversationStep,
  StepResult,
} from "../contracts/conversation.js";
import type { PatientIdentityLookup, PatientRecord } from "../contracts/ehr.js";
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
import {
  dateOfBirthReadings,
  normalizeDateOfBirth,
} from "../utils/date-of-birth.js";
import {
  dateOfBirthChoice,
  identityEscalation,
  responseFallback,
} from "./response-fallback.js";

const required = ["firstName", "lastName", "dob", "zip"] as const;
const verifiedMessage = "Thanks, your identity is verified.";
// After a required detail is requested and its need explained once, a second
// consecutive non-answer ends the conversation; questions do not count.
const MAX_UNANSWERED_REQUESTS = 2;
const MAX_CONSECUTIVE_OUTAGES = 2;

interface AuthenticationTurn {
  conversation: AuthenticatingConversation;
  received: IdentityField[];
  invalid: IdentityField[];
  question: boolean;
  // Every date a numeric DOB could mean, when it reads more than one way.
  dobReadings: string[];
}

interface AuthenticationOptions {
  extractIdentity: IdentityExtractor;
  generateResponse: ResponseGenerator;
  ehr: PatientIdentityLookup;
}

export function createAuthenticationFlow(
  options: AuthenticationOptions,
): ConversationStep<AuthenticatingConversation> {
  return async (conversation, { text }) => {
    const turn: AuthenticationTurn = {
      conversation,
      received: [],
      invalid: [],
      question: false,
      dobReadings: [],
    };
    try {
      const result = await authenticate(turn, text, options);
      delete conversation.unavailableTurns;
      return result;
    } catch {
      const outages = (conversation.unavailableTurns ?? 0) + 1;
      conversation.unavailableTurns = outages;
      if (outages >= MAX_CONSECUTIVE_OUTAGES)
        return escalate(conversation, identityEscalation.unavailable);
      return respondToDecision(
        turn,
        decisionFor(turn, "verification_unavailable"),
        options.generateResponse,
      );
    }
  };
}

async function authenticate(
  turn: AuthenticationTurn,
  text: string,
  options: AuthenticationOptions,
): Promise<StepResult> {
  const { conversation } = turn;
  const update = identityUpdateSchema.parse(
    await options.extractIdentity({
      text,
      factors: { ...conversation.factors },
      lastPrompt: conversation.lastPrompt,
    }),
  );
  turn.question = update.isQuestion;
  if (update.outOfScope) {
    countUnanswered(turn);
    return unansweredLimit(turn) ?? redirectToRefill(turn);
  }
  recordRefillIntent(conversation, update);
  applyIdentityUpdate(turn, update);
  const needed = neededIdentityFields(turn);
  const verification = needed.length
    ? { decision: requestIdentityFields(turn, needed) }
    : await verifyIdentity(turn, options.ehr);
  if ("patient" in verification)
    return identityVerified(conversation, verification.patient);
  return (
    unansweredLimit(turn) ??
    respondToDecision(
      turn,
      verification.decision,
      options.generateResponse,
      dateOfBirthQuestion(turn, verification.decision),
    )
  );
}

function countUnanswered({ conversation, question }: AuthenticationTurn) {
  if (conversation.identityPrompt && !question)
    conversation.identityPrompt.unansweredTurns++;
}

function unansweredLimit({ conversation }: AuthenticationTurn) {
  const prompt = conversation.identityPrompt;
  return prompt && prompt.unansweredTurns >= MAX_UNANSWERED_REQUESTS
    ? escalate(conversation, identityEscalation.unanswered(prompt.fields))
    : undefined;
}

// Offers both readings of an ambiguous numeric DOB instead of a generic retry.
function dateOfBirthQuestion(
  { dobReadings }: AuthenticationTurn,
  decision: AuthenticationDecision,
) {
  if (decision.action !== "request_correction" || dobReadings.length < 2)
    return undefined;
  return dateOfBirthChoice(
    dobReadings,
    decision.requestedFields.filter((field) => field !== "dob"),
  );
}

function escalate(
  conversation: AuthenticatingConversation,
  text: string,
): StepResult {
  return {
    conversation: {
      ...conversationBase(conversation),
      phase: "ended",
      outcome: "escalated",
      followUp: identityEscalation.afterwards,
    },
    messages: [{ from: "agent", text }],
    next: "reply",
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
  fixedText?: string,
): Promise<StepResult> {
  // Handoffs and outages are stated in fixed wording, never generated.
  const text =
    fixedText ??
    (decision.action === "escalate" ||
    decision.action === "verification_unavailable"
      ? responseFallback(decision)
      : await generatedText(conversation, decision, generateResponse));
  return {
    conversation:
      decision.action === "escalate"
        ? {
            ...conversationBase(conversation),
            phase: "ended",
            outcome: "escalated",
            followUp: identityEscalation.afterwards,
          }
        : conversation,
    messages: [{ from: "agent", text }],
    next: "reply",
  };
}

async function generatedText(
  conversation: AuthenticatingConversation,
  decision: AuthenticationDecision,
  generateResponse: ResponseGenerator,
) {
  try {
    const generated = await generateResponse({
      decision: structuredClone(decision),
      messages: conversation.history.map(({ from, text }) => ({ from, text })),
    });
    return generatedResponseSchema.parse(generated).text;
  } catch {
    return responseFallback(decision);
  }
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
  const { conversation } = turn;
  const missing = missingIdentityFields(conversation);
  // Before any refill or identity detail, invite a refill rather than ask for identity.
  const started =
    conversation.pendingIntent ||
    conversation.identityPrompt ||
    Object.keys(conversation.factors).length;
  const followUp = !started
    ? "If you'd like a refill, tell me which medication and I'll get started."
    : missing.length
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
      if (field === "dob") turn.dobReadings = dateOfBirthReadings(value);
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
  const { conversation, received, invalid, question } = turn;
  const previous = conversation.identityPrompt;
  const sameRequest =
    previous?.fields.length === needed.length &&
    needed.every((field) => previous.fields.includes(field));
  conversation.identityPrompt = {
    fields: needed,
    unansweredTurns:
      sameRequest && !received.length && !invalid.length && !question
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
    countUnanswered(turn);
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
  ehr: PatientIdentityLookup,
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
