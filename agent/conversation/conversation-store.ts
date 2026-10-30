import type {
  AuthenticatingConversation,
  Conversation,
} from "../domain/conversation.js";

const MAX_CONVERSATION_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_CONVERSATIONS = 100;

type Conversations = Map<string, Conversation>;
type IsPending = (id: string) => boolean;

export function createConversationStore(isPending: IsPending) {
  const conversations: Conversations = new Map();
  return {
    get(id: string, timestamp: number): Conversation {
      removeExpiredConversations(conversations, isPending, id, timestamp);
      let conversation = conversations.get(id);
      if (!conversation) {
        makeRoomForConversation(conversations, isPending);
        conversation = newConversation(timestamp);
        conversations.set(id, conversation);
      }
      conversation.touchedAt = timestamp;
      return conversation;
    },
    // Commits a turn's result; the serialized, in-flight ID is never evicted meanwhile.
    set(id: string, conversation: Conversation) {
      conversations.set(id, conversation);
    },
  };
}

function newConversation(timestamp: number): AuthenticatingConversation {
  return {
    phase: "authenticating",
    factors: {},
    history: [],
    lastPrompt: "",
    failedMatches: 0,
    createdAt: timestamp,
    touchedAt: timestamp,
  };
}

function removeExpiredConversations(
  conversations: Conversations,
  isPending: IsPending,
  currentId: string,
  timestamp: number,
) {
  for (const [id, conversation] of conversations) {
    // The current ID is serialized; other in-flight conversations must finish first.
    if (
      timestamp - conversation.createdAt >= MAX_CONVERSATION_AGE_MS &&
      (id === currentId || !isPending(id))
    )
      conversations.delete(id);
  }
}

function makeRoomForConversation(
  conversations: Conversations,
  isPending: IsPending,
) {
  if (conversations.size < MAX_CONVERSATIONS) return;
  const oldestIdle = [...conversations.entries()]
    .filter(([id]) => !isPending(id))
    .sort(([, a], [, b]) => a.touchedAt - b.touchedAt)[0];
  if (!oldestIdle)
    throw new Error("Conversation capacity reached; try again shortly");
  conversations.delete(oldestIdle[0]);
}
