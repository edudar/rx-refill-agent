import { randomUUID } from "node:crypto";
import type {
  AgentReply,
  ConversationStep,
  TurnHandler,
} from "./contracts/conversation.js";
import type {
  ConversationLogEvent,
  ConversationLogger,
} from "./contracts/logging.js";
import type { Conversation } from "./domain/conversation.js";

const MAX_CONVERSATION_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_CONVERSATIONS = 100;

export function createConversationHandler(options: {
  authenticate: ConversationStep;
  handleAuthenticated?: ConversationStep;
  logger?: ConversationLogger;
  now?: () => number;
}): TurnHandler {
  const conversations = new Map<string, Conversation>();
  const pending = new Map<string, Promise<AgentReply>>();
  const now = options.now ?? Date.now;

  const log = (event: ConversationLogEvent) => {
    try {
      options.logger?.(event);
    } catch {
      // Logging must not interrupt a conversation or change its response.
    }
  };

  async function handleTurn(id: string, text: string): Promise<AgentReply> {
    const timestamp = now();
    for (const [key, value] of conversations) {
      // The current ID is serialized; other in-flight conversations must finish first.
      if (
        timestamp - value.createdAt >= MAX_CONVERSATION_AGE_MS &&
        (key === id || !pending.has(key))
      )
        conversations.delete(key);
    }
    let conversation = conversations.get(id);
    if (!conversation) {
      if (conversations.size >= MAX_CONVERSATIONS) {
        const oldestIdle = [...conversations.entries()]
          .filter(([key]) => !pending.has(key))
          .sort(([, a], [, b]) => a.touchedAt - b.touchedAt)[0];
        if (!oldestIdle) {
          throw new Error("Conversation capacity reached; try again shortly");
        }
        conversations.delete(oldestIdle[0]);
      }
      conversation = {
        factors: {},
        lastPrompt: "",
        failedMatches: 0,
        state: "in_progress",
        createdAt: timestamp,
        touchedAt: timestamp,
      };
      conversations.set(id, conversation);
    }
    conversation.touchedAt = timestamp;

    let reply: AgentReply;
    if (conversation.state !== "in_progress") {
      reply = conversation.lastReply ?? {
        messages: [
          {
            from: "agent",
            text: "This conversation has ended. Please start a new conversation for further help.",
          },
        ],
        state: conversation.state,
      };
    } else if (!conversation.patient) {
      reply = await options.authenticate(conversation, text);
    } else if (options.handleAuthenticated) {
      reply = await options.handleAuthenticated(conversation, text);
    } else {
      // Replace this response with the refill workflow when it is implemented.
      reply = {
        messages: [
          {
            from: "agent",
            text: "Your identity is verified. Prescription selection and refill processing are not available yet.",
          },
        ],
        state: "in_progress",
      };
    }

    conversation.state = reply.state;
    conversation.lastReply = reply;
    conversation.lastPrompt = reply.messages.at(-1)?.text ?? "";
    return reply;
  }

  async function loggedTurn(id: string, text: string): Promise<AgentReply> {
    const startedAt = now();
    const turnId = randomUUID();
    const context = () => ({
      timestamp: new Date(now()).toISOString(),
      conversationId: id,
      turnId,
    });
    log({ ...context(), event: "patient_message", text });
    try {
      const reply = await handleTurn(id, text);
      log({
        ...context(),
        event: "agent_reply",
        reply,
        durationMs: Math.max(0, now() - startedAt),
      });
      return reply;
    } catch (error) {
      // Exception contents may include upstream data or credentials; do not log them.
      log({
        ...context(),
        event: "turn_error",
        durationMs: Math.max(0, now() - startedAt),
      });
      throw error;
    }
  }

  // Serialize the whole turn, including every workflow step that may mutate state.
  return (id, text) => {
    const previous = pending.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => loggedTurn(id, text));
    pending.set(id, next);
    void next
      .finally(() => {
        if (pending.get(id) === next) pending.delete(id);
      })
      .catch(() => {});
    return next;
  };
}
