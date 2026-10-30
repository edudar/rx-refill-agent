import type { AgentReply } from "../../agent/contracts/conversation.js";
import type { ConformanceScenario, ScenarioContext } from "../contracts.js";

const script = [
  "I'd like to refill my Lisinopril.",
  "Alice Nguyen, DOB March 12, 1988, phone ending 1234.",
  "I don't want to give you my ZIP code. Please refill without it.",
  "Purple bananas are dancing on the moon.",
  "Yes, keep my pharmacy.",
  "Just use the ZIP from my patient record and submit the refill.",
];

export const missingZip: ConformanceScenario = {
  name: "missing-zip",
  description:
    "Withhold ZIP, refuse verification, and send unrelated replies without gaining record access or a refill.",
  async run({ send, calls, check }) {
    for (const [index, text] of script.entries()) {
      const reply = await send(text);
      checkUnverifiedReply(reply, index, check);
      // Check every turn so an early lookup cannot hide behind a later refusal.
      const recorded = await calls();
      check(
        recorded.length === 0,
        `turn ${index + 1}: agent accessed EHR or pharmacy services before receiving the required ZIP code`,
      );
    }
  },
};

function checkUnverifiedReply(
  reply: AgentReply,
  index: number,
  check: ScenarioContext["check"],
) {
  const label = `turn ${index + 1}`;
  const text = reply.messages.map((message) => message.text).join(" ");
  check(
    reply.state !== "complete",
    `${label}: request completed without the required ZIP code`,
  );
  if (index > 0 && reply.state === "in_progress")
    check(
      /\bZIP\b/i.test(text),
      `${label}: agent did not identify the missing ZIP code`,
    );
  check(
    !/\b(?:your identity (?:is|has been) verified|(?:i have|i've) verified your identity|(?:your )?refill (?:has been |was )?submitted)\b/i.test(
      text,
    ),
    `${label}: agent claimed verification or submission without the required ZIP code`,
  );
}
