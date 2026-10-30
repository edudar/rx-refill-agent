import { randomUUID } from "node:crypto";
import type {
  AgentReply,
  ConversationMessage,
  ConversationStep,
  TurnHandler,
} from "../contracts/conversation.js";
import type {
  ConversationLogEvent,
  ConversationLogger,
} from "../contracts/logging.js";
import type { Conversation } from "../domain/conversation.js";
import { createConversationStore } from "./conversation-store.js";

interface ConversationHandlerOptions {
  authenticate: ConversationStep;
  handleAuthenticated?: ConversationStep;
  logger?: ConversationLogger;
  now?: () => number;
}

export function createConversationHandler(
  options: ConversationHandlerOptions,
): TurnHandler {
  const pending = new Map<string, Promise<AgentReply>>();
  const store = createConversationStore((id) => pending.has(id));
  const now = options.now ?? Date.now;
  const handleTurn: TurnHandler = async (id, text) => {
    const conversation = store.get(id, now());
    appendHistory(conversation, [{ from: "patient", text }]);
    const reply = await routeTurn(conversation, text, options);
    recordReply(conversation, reply);
    return reply;
  };
  const loggedTurn = withConversationLogging(handleTurn, options.logger, now);
  return (id, text) => serializeTurn(pending, id, () => loggedTurn(id, text));
}

function routeTurn(
  conversation: Conversation,
  text: string,
  options: ConversationHandlerOptions,
): Promise<AgentReply> | AgentReply {
  if (conversation.state !== "in_progress")
    return endedConversationReply(conversation);
  if (!conversation.patient) return options.authenticate(conversation, text);
  if (options.handleAuthenticated)
    return options.handleAuthenticated(conversation, text);
  // Replace this response with the refill workflow when it is implemented.
  return {
    messages: [
      {
        from: "agent",
        text: "Your identity is verified. Prescription selection and refill processing are not available yet.",
      },
    ],
    state: "in_progress",
  };
}

function endedConversationReply(conversation: Conversation): AgentReply {
  return (
    conversation.lastReply ?? {
      messages: [
        {
          from: "agent",
          text: "This conversation has ended. Please start a new conversation for further help.",
        },
      ],
      state: conversation.state,
    }
  );
}

function appendHistory(
  conversation: Conversation,
  messages: ConversationMessage[],
) {
  conversation.history = [...conversation.history, ...messages].slice(-12);
}

function recordReply(conversation: Conversation, reply: AgentReply) {
  conversation.state = reply.state;
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
