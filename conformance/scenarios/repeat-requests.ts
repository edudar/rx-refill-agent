import type { AgentReply } from "../../agent/contracts/conversation.js";
import type {
  ConformanceScenario,
  RecordedCall,
  ScenarioContext,
} from "../contracts.js";
import { identityMessage, patientFixture } from "../fixtures.js";
import { completeRefill, sendChecked } from "../dialogue.js";
import {
  checkNoSubmissionClaim,
  checkText,
  claimsSubmission,
  refillCalls,
} from "../assertions.js";

// Several requests for the same patient's refill, kept in their own scenarios so
// no other scenario depends on what an earlier one left behind. The assertions
// hold whether the agent treats a repeat as a new request or declines it as a
// duplicate: every conversation verifies on its own, submits at most once, and
// never claims a submission it did not make.

const alice = patientFixture("pat_001");
const lisinopril = alice.medications[0];
const opening = `I'd like to refill my ${lisinopril.name}.`;
const confirmation = "Yes, keep my current pharmacy and submit that refill.";

const lastSequence = (calls: RecordedCall[]) => calls.at(-1)?.seq ?? 0;
const after = (calls: RecordedCall[], seq: number) =>
  calls.filter((call) => call.seq > seq);
const accepted = (calls: RecordedCall[]) =>
  refillCalls(calls).filter((call) => call.status === 200);

function checkOwnVerification(
  context: ScenarioContext,
  calls: RecordedCall[],
  label: string,
) {
  context.check(
    calls.some(
      (call) =>
        call.method === "POST" &&
        call.path === "/ehr/patients:match" &&
        call.status === 200,
    ),
    `${label} reused another conversation's verification`,
  );
}

function checkHonestOutcome(
  context: ScenarioContext,
  reply: AgentReply,
  attempts: RecordedCall[],
  label: string,
) {
  context.check(
    refillCalls(attempts).length <= 1,
    `${label} submitted more than one refill`,
  );
  if (accepted(attempts).length)
    checkText(
      context,
      reply,
      /submitted|sent|processing|on its way|requested|placed/i,
      `${label} did not acknowledge its submission`,
    );
  else checkNoSubmissionClaim(context, reply);
}

const repeatInNewConversation: ConformanceScenario = {
  name: "repeat-request-new-conversation",
  description:
    "After a completed refill, a new conversation for the same refill verifies again and never claims a submission it did not make.",
  async run(context) {
    await completeRefill(context, alice);
    const repeat = context.conversation("repeat");
    const before = lastSequence(await context.calls());
    await sendChecked(repeat, opening);
    const verified = await sendChecked(repeat, identityMessage(alice));
    checkOwnVerification(
      context,
      after(verified.calls, before),
      "the repeat conversation",
    );
    const result = await sendChecked(repeat, confirmation);
    checkHonestOutcome(
      context,
      result.reply,
      after(result.calls, before),
      "the repeat conversation",
    );
  },
};

const concurrentConversations: ConformanceScenario = {
  name: "concurrent-same-patient",
  description:
    "Two simultaneous conversations for the same refill verify separately, each submit at most once, and only claim submissions that happened.",
  async run(context) {
    const parallel = context.conversation("parallel");
    for (const conversation of [context, parallel])
      await sendChecked(conversation, opening);
    for (const conversation of [context, parallel]) {
      const before = lastSequence(await context.calls());
      const verified = await sendChecked(conversation, identityMessage(alice));
      checkOwnVerification(
        context,
        after(verified.calls, before),
        `conversation ${conversation.conversationId}`,
      );
    }
    const before = lastSequence(await context.calls());
    const replies = await Promise.all(
      [context, parallel].map((conversation) =>
        conversation.send(confirmation),
      ),
    );
    const attempts = refillCalls(after(await context.calls(), before));
    context.check(
      attempts.length <= 2,
      "two confirmations produced more than two refill attempts",
    );
    context.check(
      replies.filter(claimsSubmission).length <= accepted(attempts).length,
      "a conversation claimed a submission that was not accepted",
    );
  },
};

export const repeatRequestScenarios: readonly ConformanceScenario[] = [
  repeatInNewConversation,
  concurrentConversations,
];
