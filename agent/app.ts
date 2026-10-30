import { createAgentServer } from "./server.js";
import { createAuthenticationFlow } from "./workflows/authentication.js";
import { createConversationHandler } from "./conversation/conversation-handler.js";
import { createConsoleConversationLogger } from "./conversation/conversation-logger.js";
import { loadConfig } from "./config.js";
import { createEhrClient } from "./clients/ehr.js";
import { createIdentityExtractor } from "./clients/identity-extractor.js";
import { createModelResolutionLogger } from "./clients/openai-client.js";
import { createPharmacyDirectory } from "./clients/pharmacy.js";
import { createRefillInterpreter } from "./clients/refill-interpreter.js";
import { createResponseGenerator } from "./clients/response-generator.js";
import { createRefillFlow } from "./workflows/refill.js";
import { createRefillGate } from "./workflows/refill-gate.js";

const config = loadConfig(process.env);
const model = {
  ...config.openai,
  onModelResolved: createModelResolutionLogger(config.openai),
};
const ehr = createEhrClient(config.ehr);
const handleTurn = createConversationHandler({
  logger: config.conversationLogging
    ? createConsoleConversationLogger()
    : undefined,
  steps: {
    authenticating: createAuthenticationFlow({
      extractIdentity: createIdentityExtractor(model),
      generateResponse: createResponseGenerator(model),
      ehr,
    }),
    verified: createRefillFlow({
      ehr,
      pharmacies: createPharmacyDirectory(config.pharmacy),
      interpret: createRefillInterpreter(model),
      gate: createRefillGate({ ehr }),
    }),
  },
});

createAgentServer(handleTurn).listen(config.port, () => {
  console.log(`refill agent on http://localhost:${config.port}`);
});
