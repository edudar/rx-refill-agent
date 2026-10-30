import { createAgentServer } from "./server.js";
import { createAuthenticationFlow } from "./workflows/authentication.js";
import { createConversationHandler } from "./conversation/conversation-handler.js";
import { createConsoleConversationLogger } from "./conversation/conversation-logger.js";
import { loadConfig } from "./config.js";
import { createEhrClient } from "./clients/ehr.js";
import { createIdentityExtractor } from "./clients/identity-extractor.js";
import { createResponseGenerator } from "./clients/response-generator.js";

const config = loadConfig(process.env);
const handleTurn = createConversationHandler({
  logger: config.conversationLogging
    ? createConsoleConversationLogger()
    : undefined,
  authenticate: createAuthenticationFlow({
    extractIdentity: createIdentityExtractor(config.openai),
    generateResponse: createResponseGenerator(config.openai),
    ehr: createEhrClient(config.ehr),
  }),
});

createAgentServer(handleTurn).listen(config.port, () => {
  console.log(`refill agent on http://localhost:${config.port}`);
});
