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

Then `npm run conformance` checks it. `npm test` needs no credentials.

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

Invalid values fail at startup. `.env.openai` is a template: copy it to `.env` and run
`node --env-file=.env --import=tsx agent/app.ts`.

## Model

OpenAI Responses API, model `gpt-6-luna`, reasoning effort `none`, Structured Outputs,
`store: false`, no tools. The agent logs a `model_resolved` line with the model the API
reports the first time it answers. In the 2026-10-30 runs the API reported
`gpt-6-luna` itself; it returned no dated snapshot identifier.

## Key design decisions

- **Code decides, the model proposes.** Three model calls extract identity fields,
  interpret refill turns, and phrase identity prompts. Application code validates every
  value, resolves medications and pharmacies against retrieved records, applies the
  clinical rules, and decides every transition. Models never see retrieved records.
- **Explicit conversation phases.** State is a union of `authenticating`, `verified`, and
  `ended`. The verifying turn hands off to the refill in the same turn, and turns commit
  only when they succeed.
- **Pure clinical rules.** One function evaluates docs/API.md §4 against the EHR clock
  in UTC calendar days, with inclusive boundaries. Prescriber issues escalate; early
  refills and missing labs hold.
- **One write path.** A gate re-reads the record and re-applies the rules, updates the
  pharmacy only when the confirmed destination differs, and submits only after that
  update succeeds. It keeps no state, so conversations never affect each other; a
  submitted or uncertain refill ends its conversation, which prevents repeats.
- **Fixed wording for anything that matters.** Clinical declines, proposals, submission
  results, outages, verification, and handoffs are templates that claim only what
  happened. The model phrases only identity-collection prompts.

## Failure and safety

- Records are read only after a unique demographic match whose record agrees with the
  supplied identity; three failed attempts escalate.
- Only a destination already shown to the patient can be confirmed; a medication not on
  the record is never substituted; claimed overrides ("I'm verified", "my doctor
  approved it") change nothing.
- A 4xx refill failure is reported and may be retried. A 5xx, timeout, or unreadable
  response may hide an accepted refill, so it is never resent and the conversation
  escalates. Failed reads or pharmacy updates write no refill.
- Unit tests (`npm test`) cover rule boundaries, every write outcome, concurrency, and
  wording guarantees. 53 conformance scenarios cover identity, clinical, medication,
  pharmacy, conversation, and outage cases (`IMPLEMENTATION.md`).

## Status

On 2026-10-30, `npm run conformance` passed all 53 scenarios against `gpt-6-luna` with
reasoning effort `none` (53 passed, 0 failed, 0 skipped), and all unit tests, type
checking, and formatting pass. That is one live run: model output varies between runs,
and conformance reply checks are lexical, so transcripts still deserve review. State is
in memory, and escalation does not create an external handoff. AI session transcripts
go in `docs/ai-log/`.
