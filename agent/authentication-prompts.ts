import type { IdentityMessageTopic } from "./contracts/identity-extraction.js";
import type { Conversation } from "./domain/conversation.js";
import type { IdentityFactors } from "./domain/identity.js";

const list = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
const labels: Record<keyof IdentityFactors, string> = {
  firstName: "first name",
  lastName: "last name",
  dob: "date of birth",
  zip: "five-digit ZIP code",
  phoneLast4: "phone number's last four digits",
};

function describe(fields: (keyof IdentityFactors)[], acknowledgement = false) {
  const names: string[] = [];
  for (const field of fields) {
    if (field === "firstName" && fields.includes("lastName")) {
      names.push(acknowledgement ? "name" : "full name");
    } else if (field !== "lastName" || !fields.includes("firstName")) {
      names.push(labels[field]);
    }
  }
  return list.format(names);
}

export function createMissingIdentityPrompt(options: {
  conversation: Conversation;
  needed: (keyof IdentityFactors)[];
  received: (keyof IdentityFactors)[];
  invalid: (keyof IdentityFactors)[];
  topic: IdentityMessageTopic;
  outOfScope: boolean;
}): string {
  const { conversation, needed, received, invalid, topic, outOfScope } =
    options;
  const previous = conversation.identityPrompt;
  const sameRequest =
    previous?.fields.length === needed.length &&
    needed.every((field) => previous.fields.includes(field));
  const unansweredTurns =
    sameRequest && !received.length && !invalid.length
      ? previous.unansweredTurns + 1
      : 0;
  conversation.identityPrompt = { fields: [...needed], unansweredTurns };

  const parts: string[] = [];
  if (outOfScope) {
    parts.push("I can help with prescription refills and pharmacy changes.");
  } else if (received.length) {
    parts.push(`Thanks, I have your ${describe(received, true)}.`);
  } else if (topic === "pharmacy") {
    parts.push("We can confirm your pharmacy after verifying your identity.");
  } else if (topic === "verification") {
    parts.push(
      "I use these details to match you to the right patient record before accessing your prescriptions.",
    );
  }

  if (invalid.length) {
    if (invalid.includes("dob")) {
      parts.push(
        "Please give your date of birth with the month written out, for example, March 12, 1988.",
      );
    }
    if (invalid.includes("zip")) parts.push("ZIP codes need five digits.");
    if (invalid.includes("phoneLast4"))
      parts.push(
        "The phone ending needs four digits; you can also leave it out.",
      );
    const remaining = needed.filter(
      (field) => field !== "dob" || !invalid.includes("dob"),
    );
    if (remaining.length)
      parts.push(`Could you share your ${describe(remaining)}?`);
  } else if (unansweredTurns >= 2) {
    parts.push(
      `I can't look up your prescription without your ${describe(needed)}. If you're unsure of those details, your care team can help.`,
    );
  } else if (unansweredTurns === 1) {
    parts.push(
      `I still need your ${describe(needed)} to verify your identity. Could you send ${needed.length === 1 ? "that" : "those details"}?`,
    );
  } else if (received.length || conversation.lastPrompt || outOfScope) {
    parts.push(`Could you share your ${describe(needed)}?`);
  } else {
    parts.push(
      `I can help with that refill. To verify your identity, could you share your ${describe(needed)}?`,
    );
  }
  return parts.join(" ");
}
