import { createAgentServer } from "./server.js";
import { createAuthenticationFlow } from "./authentication.js";
import { createConversationHandler } from "./conversation-handler.js";
import { createConsoleConversationLogger } from "./conversation-logger.js";
import { loadConfig } from "./config.js";
import { createEhrClient } from "./ehr.js";
import { createIdentityExtractor } from "./identity-extractor.js";

const config = loadConfig(process.env);
const handleTurn = createConversationHandler({
  logger: config.conversationLogging
    ? createConsoleConversationLogger()
    : undefined,
  authenticate: createAuthenticationFlow({
    extractIdentity: createIdentityExtractor(config.openai),
    ehr: createEhrClient(config.ehr),
  }),
});

createAgentServer(handleTurn).listen(config.port, () => {
  console.log(`refill agent on http://localhost:${config.port}`);
});
