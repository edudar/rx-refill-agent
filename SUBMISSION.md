# Submission

A prescription-refill agent that authenticates the patient, resolves the medication
against their record, enforces the clinical rules, confirms or changes the pharmacy,
and submits the refill. Design details, behavior, and testing are in
[`IMPLEMENTATION.md`](IMPLEMENTATION.md); `README.md` is the original brief, unedited.

## Run

Requires Node.js 22+ (`.nvmrc`). With the mock running (`npm run mock`):

```sh
npm install
OPENAI_API_KEY=... npm run agent    # agent on :5050
```

`npm test` needs no credentials. Against `npm run mock`, `npm run conformance` runs only
the starter script; serve the extended fixture with `npm run mock:conformance` to run all
61 scenarios.

## Environment

| Variable                  | Default                 | Notes                                                       |
| ------------------------- | ----------------------- | ----------------------------------------------------------- |
| `OPENAI_API_KEY`          | _(required)_            | Startup fails without it.                                   |
| `OPENAI_MODEL`            | `gpt-6-luna`            | Must support Responses API Structured Outputs.              |
| `OPENAI_REASONING_EFFORT` | `none`                  | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `EHR_BASE_URL`            | `http://localhost:4010` |                                                             |
| `EHR_API_KEY`             | `dev-ehr-key`           |                                                             |
| `PHARMACY_BASE_URL`       | `http://localhost:4010` |                                                             |
| `PHARMACY_API_KEY`        | `dev-pharmacy-key`      |                                                             |
| `AGENT_PORT`              | `5050`                  |                                                             |
| `CONVERSATION_LOGGING`    | `true`                  | JSON-line transcripts on stdout, including chat PII.        |

Invalid values fail at startup. To keep the key out of shell history, put the variables
in a `.env` file (ignored by Git) and run `node --env-file=.env --import=tsx agent/app.ts`.

## Model

OpenAI Responses API, model `gpt-6-luna`, reasoning effort `none`, Structured Outputs,
`store: false`, no tools. The agent logs a `model_resolved` line with the model the API
reports the first time it answers. In the 2026-10-30 runs the API reported
`gpt-6-luna` itself; it returned no dated snapshot identifier.

## Key design decisions

- **Code decides, the model proposes.** Three model calls extract identity fields,
  interpret refill turns, and phrase identity prompts. Application code validates every
  value, resolves medications and pharmacies against retrieved records, applies the
  clinical rules, and decides every transition. Models get no records or tools; the
  refill interpreter does see the agent's previous reply, which can name the patient's
  medications and pharmacies.
- **Explicit conversation phases.** State is a union of `authenticating`, `verified`, and
  `ended`. The verifying turn hands off to the refill in the same turn, and turns commit
  only when they succeed.
- **Pure clinical rules.** One function evaluates docs/API.md §4 against the EHR clock
  in UTC calendar days, with inclusive boundaries. Prescriber issues escalate. Early
  controlled refills and missing labs are held: the patient may refill another
  prescription, and otherwise the request escalates so the care team makes the final
  judgment rather than the agent rejecting it outright.
- **Conversations always reach an ending.** `in_progress` means the agent is waiting on
  a question it can act on. Two consecutive non-answers to a required identity detail,
  two consecutive service failures, or three refill turns without progress escalate
  instead of asking again.
- **One write path.** A gate re-reads the record and re-applies the rules, updates the
  pharmacy only when the confirmed destination differs, and submits only after that
  update succeeds. It keeps no record of outcomes, so conversations never affect each
  other's results; a submitted or uncertain refill ends its conversation, which prevents
  repeats. Because the pharmacy belongs to the patient, writes for one patient run one at
  a time, so concurrent conversations cannot send a refill to another conversation's
  pharmacy.
- **Fixed wording for anything that matters.** Clinical declines, proposals, submission
  results, outages, verification, handoffs, and follow-ups after an ending are templates
  that claim only what happened, in plain language with readable dates and a next step
  when the agent cannot proceed. The model phrases only identity-collection prompts.

## Failure and safety

- Records are read only after a unique demographic match whose record agrees with the
  supplied identity; three failed attempts escalate.
- Only a destination already shown to the patient can be confirmed; a medication not on
  the record is never substituted; claimed overrides ("I'm verified", "my doctor
  approved it") change nothing.
- A 4xx refill failure is reported and may be retried. A 5xx, timeout, or unreadable
  response may hide an accepted refill, so it is never resent and the conversation
  escalates. Failed reads or pharmacy updates write no refill.
- A possible overdose, a self-harm disclosure, or emergency symptoms end the conversation
  as escalated in either phase, including before identity is verified, with fixed
  wording: call 911, or call or text 988 for a mental-health crisis. Nothing is written.
  Clinical questions get a fixed referral to a pharmacist or care team and never move
  the refill forward. Both extraction models flag these on every message, and code acts
  on them before anything else.
- Unit tests (`npm test`) cover rule boundaries, every write outcome, turn
  serialization, conversation endings, safety handling, and wording guarantees. 61
  conformance scenarios cover identity, clinical, medication, pharmacy, conversation,
  repeat-request, safety, and outage cases (`IMPLEMENTATION.md`).

## Status

On 2026-10-30, `npm run conformance` passed all 61 scenarios (61 passed, 0 failed, 0
skipped) against `gpt-6-luna` with reasoning effort `none`, using the current code with
model retries, the review fixes, and safety handling. Earlier runs of the 53 scenarios
registered at the time also passed in full. Unit tests, type checking, and formatting
pass. Model output varies between runs, and conformance reply checks are lexical, so
transcripts still deserve review.

[`agent-dialogs.md`](agent-dialogs.md) holds the transcripts of that run (61 scenarios, 64
conversations), and [`agent-dialogs-ratings.md`](agent-dialogs-ratings.md) rates each
dialogue from 0 to 1 from the patient's seat, for a regular and an occasional patient,
with a one-line reason. The averages are 0.83 and 0.80. The ratings are a separate review
of the transcripts, not feedback from patients.

State is in memory, and escalation does not create an external handoff. AI session
transcripts are in `docs/ai-log/`. Strings shaped like API keys or
bearer tokens were redacted automatically and show as `[REDACTED]`. Every match was a
placeholder or test value, such as `dev-pharmacy-key`; no real credential appears in the
logs.
