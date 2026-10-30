import type { ConversationLogger } from "../contracts/logging.js";

export function createConsoleConversationLogger(
  write: (line: string) => void = console.log,
): ConversationLogger {
  // JSON keeps multiline text and terminal control characters inside one log record.
  return (event) => write(JSON.stringify(event));
}
