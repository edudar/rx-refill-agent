import { randomUUID } from "node:crypto";
import type {
  AgentMessage,
  AgentReply,
  ConversationMessage,
  ConversationStep,
  StepResult,
  TurnHandler,
  TurnInput,
} from "../contracts/conversation.js";
import type {
  ConversationLogEvent,
  ConversationLogger,
} from "../contracts/logging.js";
import {
  replyState,
  type AuthenticatingConversation,
  type Conversation,
  type VerifiedConversation,
} from "../domain/conversation.js";
import { createConversationStore } from "./conversation-store.js";

// Each hand-off must change phase, so this only bounds a misbehaving step.
const MAX_STEPS_PER_TURN = 4;

export interface ConversationSteps {
  authenticating: ConversationStep<AuthenticatingConversation>;
  verified?: ConversationStep<VerifiedConversation>;
}

interface ConversationHandlerOptions {
  steps: ConversationSteps;
  logger?: ConversationLogger;
  now?: () => number;
}

interface TurnOutcome {
  conversation: Conversation;
  reply: AgentReply;
}

export function createConversationHandler(
  options: ConversationHandlerOptions,
): TurnHandler {
  const pending = new Map<string, Promise<AgentReply>>();
  const store = createConversationStore((id) => pending.has(id));
  const now = options.now ?? Date.now;
  const handleTurn: TurnHandler = async (id, text) => {
    // Steps work on a draft; a turn that throws leaves the stored state untouched.
    const draft = structuredClone(store.get(id, now()));
    appendHistory(draft, [{ from: "patient", text }]);
    const { conversation, reply } = await runTurn(draft, text, options.steps);
    recordReply(conversation, reply);
    store.set(id, conversation);
    return reply;
  };
  const loggedTurn = withConversationLogging(handleTurn, options.logger, now);
  return (id, text) => serializeTurn(pending, id, () => loggedTurn(id, text));
}

async function runTurn(
  initial: Conversation,
  text: string,
  steps: ConversationSteps,
): Promise<TurnOutcome> {
  if (initial.phase === "ended") return endedConversation(initial);
  let current = initial;
  const messages: AgentMessage[] = [];
  for (let hop = 0; hop < MAX_STEPS_PER_TURN; hop++) {
    const {
      conversation,
      messages: stepMessages,
      next,
    } = await runStep(current, { text, handedOff: hop > 0 }, steps);
    messages.push(...stepMessages);
    if (next === "continue" && conversation.phase === current.phase)
      throw new Error(`Step ${current.phase} continued without a transition`);
    if (next === "reply" || conversation.phase === "ended") {
      if (!messages.length)
        throw new Error(`Step ${current.phase} produced no reply`);
      return {
        conversation,
        reply: { messages, state: replyState(conversation) },
      };
    }
    current = conversation;
  }
  throw new Error("Conversation exceeded its steps for one turn");
}

function runStep(
  conversation: Exclude<Conversation, { phase: "ended" }>,
  turn: TurnInput,
  steps: ConversationSteps,
): Promise<StepResult> {
  switch (conversation.phase) {
    case "authenticating":
      return steps.authenticating(conversation, turn);
    case "verified":
      return (steps.verified ?? refillUnavailable)(conversation, turn);
  }
}

// Replace this step with the refill workflow when it is implemented.
const refillUnavailable: ConversationStep<VerifiedConversation> = async (
  conversation,
) => ({
  conversation,
  messages: [
    {
      from: "agent",
      text: "Prescription selection and refill processing are not available yet.",
    },
  ],
  next: "reply",
});

function endedConversation(conversation: Conversation): TurnOutcome {
  return {
    conversation,
    reply: conversation.lastReply ?? {
      messages: [
        {
          from: "agent",
          text: "This conversation has ended. Please start a new conversation for further help.",
        },
      ],
      state: replyState(conversation),
    },
  };
}

function appendHistory(
  conversation: Conversation,
  messages: ConversationMessage[],
) {
  conversation.history = [...conversation.history, ...messages].slice(-12);
}

function recordReply(conversation: Conversation, reply: AgentReply) {
  conversation.lastReply = reply;
  conversation.lastPrompt = reply.messages.at(-1)?.text ?? "";
  appendHistory(conversation, reply.messages);
}

function logSafely(
  logger: ConversationLogger | undefined,
  event: ConversationLogEvent,
) {
  try {
    logger?.(event);
  } catch {
    // Logging must not interrupt a conversation or change its response.
  }
}

function withConversationLogging(
  handleTurn: TurnHandler,
  logger: ConversationLogger | undefined,
  now: () => number,
): TurnHandler {
  return async (id, text) => {
    const startedAt = now();
    const turnId = randomUUID();
    const context = () => ({
      timestamp: new Date(now()).toISOString(),
      conversationId: id,
      turnId,
    });
    logSafely(logger, { ...context(), event: "patient_message", text });
    try {
      const reply = await handleTurn(id, text);
      logSafely(logger, {
        ...context(),
        event: "agent_reply",
        reply,
        durationMs: Math.max(0, now() - startedAt),
      });
      return reply;
    } catch (error) {
      // Exception contents may include upstream data or credentials; do not log them.
      logSafely(logger, {
        ...context(),
        event: "turn_error",
        durationMs: Math.max(0, now() - startedAt),
      });
      throw error;
    }
  };
}

function serializeTurn(
  pending: Map<string, Promise<AgentReply>>,
  id: string,
  run: () => Promise<AgentReply>,
) {
  const previous = pending.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  pending.set(id, next);
  void next
    .finally(() => {
      if (pending.get(id) === next) pending.delete(id);
    })
    .catch(() => {});
  return next;
}
