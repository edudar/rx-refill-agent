# Implementation notes

Detailed design, behavior, and testing notes. `SUBMISSION.md` is the short summary;
`README.md` is the original assessment brief from the starter commit (`80f19f7`) and
is never edited or reformatted (it is excluded from Prettier).

## Architecture

```
HTTP (server.ts) -> conversation handler -> phase step -> clients
                    serialize, draft,        authenticating: authentication.ts
                    commit, log              verified:       refill.ts -> refill gate
```

- `agent/server.ts` owns HTTP transport and request validation; `agent/app.ts` loads
  configuration and composes clients, workflows, and the conversation handler.
- `agent/conversation/` routes turns by phase, serializes turns per conversation,
  stores conversations, and logs them.
- `agent/workflows/` holds workflow policy: `authentication.ts`, `refill.ts`, the
  `refill-gate.ts` write path, and fixed wording in `refill-messages.ts` and
  `response-fallback.ts`.
- `agent/domain/` holds conversation state types, identity validation, the clinical
  rules (`refill-eligibility.ts`), and deterministic name matching (`refill-choices.ts`).
- `agent/clients/` holds external adapters: `ehr.ts`, `pharmacy.ts` (both built on
  `json-service.ts`), `openai-client.ts`, and the three model calls
  (`identity-extractor.ts`, `response-generator.ts`, `refill-interpreter.ts`).
- `agent/contracts/` holds Zod schemas with their inferred types for HTTP, EHR,
  pharmacy, service errors, model I/O, and logging.
- `agent/config.ts` reads only the environment passed to `loadConfig(env)`; importing
  it has no side effects. `agent/utils/date-of-birth.ts` normalizes DOBs.

Tests sit beside their modules. Folders are plain source folders: no barrels,
separate packages, or build step.

### Least privilege

Each workflow receives only the clients it needs. Authentication gets `match` and
`getPatient`. The refill workflow gets EHR reads (`getTime`, `getMedications`,
`getLabs`, `getPharmacy`), pharmacy directory search, and the refill gate. Only the
gate calls `setPharmacy` and `submitRefill`. No model has tools.

## Conversation phases and turns

Conversation state is a discriminated union by `phase` (`agent/domain/conversation.ts`):

| Phase            | Holds                                                  |
| ---------------- | ------------------------------------------------------ |
| `authenticating` | identity factors, failed match attempts, last prompt   |
| `verified`       | the matched patient record and optional `refill` state |
| `ended`          | outcome: `complete` or `escalated`                     |

Identity factors are dropped once verification succeeds. The reply `state` is derived
from the phase, so a step cannot report a state that disagrees with it.

Each phase has one step, which returns the next conversation, its messages, and
`reply` or `continue`. `continue` hands the same patient message to the next phase,
so the verifying turn continues straight into the refill: the starter script verifies
on its second message and confirms the pharmacy on its third. A hand-off must change
phase, a turn is capped at four steps, and the receiving step gets `handedOff: true`
so it never treats the identity message as an answer to its own question.

Steps work on a cloned draft that the store commits only when the turn succeeds, so a
turn that throws leaves no partial updates or dangling history. Ended conversations
replay their last reply, so thanks, status questions, or repeated confirmations never
reach a workflow again.

Turns for one conversation run strictly in order. State is in memory and discarded on
restart: at most 12 recent messages per conversation, conversations expire 24 hours
after creation, and at most 100 are kept, evicting the least recently used idle one.
In-flight conversations are never evicted; if all 100 are busy, new ones are rejected
until capacity frees. Conversation IDs are assumed to come from a trusted front end.

## Authentication

Full name, date of birth, and five-digit ZIP are required, collected across messages.
The last four phone digits are optional; if supplied they are validated and included
in matching and record verification. A record is fetched only after a unique match,
and its demographics must agree with the supplied identity. An ambiguous match asks for
phone digits. Three distinct failed attempts escalate. This is demographic matching
only, with no OTP or proof of possession.

DOBs may use month names or abbreviations (`March 12, 1988`, `12 Mar 1988`), year-first
dates (`1988/3/12`), or unambiguous numeric dates (`12/31/1988`, `31/12/1988`). The model
returns the date as written; Day.js parses it strictly against every supported format
and accepts only a single distinct result. Ambiguous dates such as `03/04/1988`,
two-digit years, and impossible dates prompt for the month written out. No locale is
inferred from ZIP or phone.

Each authentication turn uses two model calls: extraction (identity fields, scope, and
any `medicationMention`) and response generation, which phrases the application's
decision using field names and the last 12 messages, never retrieved records. Two
messages are fixed text instead: the verification confirmation ("Thanks, your identity
is verified.") and the escalation handoff. Out-of-scope messages get a fixed redirect
and cannot change identity or intent. Malformed, refused, or failed generation falls
back to short fixed text for the same decision.

A medication named before verification is kept as `pendingIntent` (latest mention wins,
at most 100 characters). It is never sent to the EHR or matched against records before
verification.

## Refill workflow

`agent/workflows/refill.ts` handles the `verified` phase. On the hand-off turn it skips
interpretation and starts from `pendingIntent`. On later turns, one model call
(`refill-interpreter.ts`) turns the message into a proposal: scope, intent (`confirm`,
`decline`, `change_pharmacy`, `cancel`, `other`), a medication mention, a numbered option,
a pharmacy name and location, and whether to keep the current pharmacy. The model sees
only the message, the question asked, and the last prompt. The application resolves
everything else.

Refill state (`RefillState`) is one of `choosing_medication`, `choosing_pharmacy`, or
`confirming`; no state means no medication has been chosen yet.

**Medication.** Mentions are matched against the freshly read record
(`matchMedications`): every meaningful word must appear in the medication name, so
"amlodipine" matches both strengths and "the 10mg one" matches only `Amlodipine 10mg`.
A unique match is reviewed; several are listed for a choice; none means "I don't see X
on your record" plus the actual list. Nothing is ever substituted. Naming a different
medication at any point restarts selection, and never confirms in that same turn.

**Review.** The chosen medication is checked against the EHR clock and required labs.
`escalate` dispositions end the conversation as `escalated`; `hold` dispositions explain
the reason and let the patient choose another medication. An eligible refill reads the
current pharmacy and proposes it; with none on file, the patient is asked for one.

**Pharmacy.** A named pharmacy is first matched against destinations already presented
in this refill (`findNamedPharmacy`, which requires a unique match). Otherwise the
directory is searched by name; a location only narrows several name matches, so an
unknown name never turns into unrelated pharmacies on the same street. One result is
proposed for confirmation; several are listed as numbered options (up to five); none
asks for another name or address.

**Confirmation.** Only a destination already shown to the patient can be confirmed. A
"yes" confirms the proposal; "keep Mission Rx and submit" confirms a presented
pharmacy directly; "change to Bay Pharmacy and submit" for a pharmacy not yet shown only
proposes it. Confirmation submits through the refill gate. Cancelling completes the
conversation without writes.

Unrelated requests get a fixed redirect followed by the current question. If the
interpreter fails, nothing changes and the patient is asked to try again. Read
outages report that nothing was submitted.

### Fixed wording

Every refill reply comes from `refill-messages.ts`: clinical declines, proposals,
choices, submission results, outages, and handoffs. Each sentence claims only what the
application did. Only the success message says a refill was submitted, and failed
pharmacy updates never say the pharmacy changed; `refill-messages.test.ts` checks both.
Patient wording echoed back is trimmed to one short line.

## Clinical rules

`evaluateRefillEligibility(medication, labs, now)` (`agent/domain/refill-eligibility.ts`)
is a pure function of docs/API.md §4. It returns `eligible`, or every failed rule plus a
disposition:

| Rule                                        | Disposition |
| ------------------------------------------- | ----------- |
| Schedule II                                 | escalate    |
| no refills remaining                        | escalate    |
| prescription expired                        | escalate    |
| controlled (CIII–CV) more than 2 days early | hold        |
| required lab missing, stale, or future      | hold        |

Rules use the UTC calendar day of `GET /ehr/time`, never the host clock. The expiration
day, the day exactly two days before a controlled supply runs out, and a lab exactly
`withinDays` old are allowed. A controlled flag without a schedule still gets the
early-refill rule; lab types compare case-insensitively. Malformed records fail EHR
schema validation as a whole, and impossible dates throw rather than shift a rule.

## EHR writes and failure semantics

Every write goes through the refill gate (`agent/workflows/refill-gate.ts`). Given a
verified conversation and the exact medication and pharmacy the patient confirmed, it:

1. refuses an order for any patient other than the verified one;
2. re-reads the clock, medications, and required labs and re-applies the rules, so a
   record that changed after the proposal is judged as it is now;
3. updates the pharmacy only if the confirmed destination differs, and never submits
   unless that update succeeded;
4. submits once and reports the outcome; it never throws.

A 24-hour submission ledger outside conversation state, keyed by patient and
medication and claimed before any request, means a rolled-back turn, an evicted
conversation, or a second conversation for the same patient cannot repeat a refill,
and concurrent attempts submit only once.

EHR and pharmacy clients (`json-service.ts`) classify failures by whether the service
could have acted: `rejected` (4xx), `unavailable` (5xx), `no_response`, and
`invalid_response`. Error messages never include response bodies.

| Gate outcome                                                | Meaning                             | Conversation            |
| ----------------------------------------------------------- | ----------------------------------- | ----------------------- |
| `submitted`, `already_submitted`                            | refill on file                      | complete                |
| `unavailable`                                               | a read failed; nothing written      | retry by confirming     |
| `pharmacy_update_failed`                                    | update failed; no refill sent       | retry by confirming     |
| `submission_rejected` (4xx)                                 | EHR refused the refill              | retry by confirming     |
| `submission_unknown`                                        | 5xx, timeout, or unreadable success | escalated, never resent |
| `ineligible`                                                | the record changed since the review | escalated or held       |
| `submission_in_progress`                                    | another conversation is submitting  | in progress             |
| `not_authorized`, `medication_not_found`, `cannot_evaluate` | cannot be evaluated as given        | escalated               |

A 503 is treated as an unknown outcome: a refill cannot be safely repeated, and HTTP
does not guarantee a 503 was not applied.

## Configuration details

Model calls use the OpenAI Responses API with Structured Outputs, `store: false`, a
15-second timeout, and no automatic retries. Visible output caps are 512 tokens for
extraction and interpretation and 1,024 for response generation. Reasoning tokens
count against `max_output_tokens`, so any effort other than `none` adds a 4,096-token
allowance to each cap. Incomplete responses report the API's reason without model or
patient text. The effort is always sent explicitly. The agent logs a `model_resolved`
JSON line the first time each model snapshot answers, so any run records the exact
model version even when conversation logging is off. EHR and pharmacy requests time out
after 5 seconds and refuse redirects.

## Logging

Conversation logging is on by default; disable it with `CONVERSATION_LOGGING=false`
(only `true` and `false` are accepted). Each turn logs a `patient_message` record and an
`agent_reply` record (or `turn_error`) as JSON lines with timestamps, conversation IDs,
and turn IDs, so interleaved conversations can be followed. Message text is verbatim and
so contains identity details supplied in chat. Retrieved records, configuration, and
exception contents are not logged. Logging failures never change replies.

Every failed model call also logs a `model_failed` line, whatever the conversation
logging setting: the stage (identity extraction, response generation, or refill
interpretation), the model, the error class, and, when present, the HTTP status, the
OpenAI error `type` and `code`, the incomplete reason, the request ID, and any
`x-ratelimit-*` response headers under `rateLimit` (for example `limit-requests`,
`remaining-requests`, `reset-requests`). A rate limit appears as `RateLimitError` with
status 429 and code `rate_limit_exceeded`; `rateLimit` shows which window was exhausted
and when it resets. A spent quota appears as code `insufficient_quota`. Error messages are never logged, because they can
quote request content. The caller's fallback reply is unchanged.

## Testing

```sh
npm test              # unit and harness tests; no credentials or network
npm run typecheck
npm run format:check
npm run test:mutation # StrykerJS; fails below a 75% mutation score
```

Unit tests inject simulated model, EHR, and pharmacy responses.
`scripts/test-environment.mjs` removes credentials and blocks non-loopback fetches.
Coverage includes identity collection and correction, DOB parsing, matching and
escalation, phase hand-offs and transactional turns, every clinical rule boundary,
medication and pharmacy resolution, confirmation rules, every gate outcome including
concurrent and uncertain submissions, and the wording guarantees above.
`refill.test.ts` drives the real handler, refill workflow, and gate together. These
tests do not measure model quality; live conformance does.

### Conformance

```sh
npm run mock:conformance                # mock serving conformance/dataset.json
npm run conformance                     # every registered scenario
npm run conformance -- --list           # list scenarios and the harness each needs
npm run conformance -- change-pharmacy  # run selected scenarios
npm run conformance:starter             # the assessment's original script, verbatim
```

`npm run mock` serves the starter mock's interface unchanged: the same routes, status
codes, bodies, and mutations (no clinical enforcement, no refill consumption), the same
`mock/dataset.json`, and the starter semantics of `POST /__reset` and `GET /__calls`.
Call records only add `status` and `response`. `conformance/starter/run.ts` is a verbatim
copy of the original script, and `starter-happy-path` runs the same three messages
inside the suite. Against a starter mock, every other scenario is reported as `SKIP`.

Test controls live only under `/__harness`: `GET /__harness` describes capabilities,
clock, and patient IDs; `POST /__harness/restore` returns all mock state to startup;
`POST /__harness/faults { method, path, times }` makes matching requests return 503
without applying them. Scenarios declare the capabilities they need, and the runner
skips unsupported ones with a reason; naming an unsupported scenario explicitly fails.
Extended scenarios use `conformance/dataset.json` (the starter patients plus synthetic
`pat_013`–`pat_026`) and its clock `2026-09-01T12:00:00Z`; leave `SIM_NOW` unset.
`AGENT_BASE` and `MOCK_BASE` override the default URLs.

The runner checks readiness, runs scenarios sequentially against one dedicated mock,
restores the fixture and assigns a fresh conversation ID per scenario, continues after
failures, and exits nonzero if any fail. Assertions check the mock call log: unique
matching with all required factors before record access, patient and medication
binding, review of the clock and required labs, confirmation before writes, the
destination update before submission, and exactly one accepted submission. Reply checks
are lexical smoke checks (broad terms and unsupported-claim patterns), not semantic
evaluation; transcripts still deserve review. Outage cases inject definite 503s, not
dropped connections.

`npm test` also checks the assertion helpers against good and corrupted evidence and
runs every scenario against an idle fake agent, which every workflow case must detect.

| Group             | Scenarios                                                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starter and happy | `starter-happy-path`, `happy-path`, `missing-zip`                                                                                                                                                   |
| Identity          | `corrected-identity`, `ambiguous-patient-*` (3), `dob-written-month`, `dob-unambiguous-numeric`, `dob-ambiguous-clarified`, `city-instead-of-zip`, `full-phone-number`                              |
| Declines          | `schedule-ii`, `expired-no-refills`, `controlled-too-early`, `stale-lab`, `no-refills-only`, `expired-only`, `controlled-outside-window`, `lab-*` (4), `expiration-yesterday`                       |
| Approvals         | `controlled-within-window`, `non-controlled-early`, `recent-lab`, `controlled-exact-window`, `lab-exact-age`, `lab-multiple-results`, `expiration-today`                                            |
| Medications       | `medication-clarification`, `switch-blocked-medication`, `medication-not-on-record`, `medication-strength-clarification`                                                                            |
| Pharmacies        | `change-pharmacy`, `pharmacy-search-ambiguous`, `pharmacy-search-no-match`, `withdraw-pharmacy-change`, `no-current-pharmacy`                                                                       |
| Conversation      | `cancel-refill`, `unrelated-code-request`, `unrelated-web-requests`, `bypass-authentication`, `bypass-clinical-rule`, `premature-confirmation`, `no-duplicate-submission`, `conversation-isolation` |
| Outages           | `ehr-lookup-outage`, `pharmacy-update-failure`, `refill-submission-failure`                                                                                                                         |

Schedule II, exhausted-refill, and expiration cases require `escalated`; early
controlled refills and lab problems require a hold or escalation. Ambiguity stays
`in_progress` until resolved, cancellation completes without writes, and outages accept
a retry prompt or escalation but never a success claim.

### Mutation testing

StrykerJS runs the unit suite through its command runner and mutates agent runtime
code (excluding tests and `agent/app.ts`). `thresholds.break` fails a run below a 75%
project-wide score; type-invalid mutants are reported as `CompileError`, not kills.
Reports go to `reports/mutation/` (ignored by Git). A full run takes several minutes;
narrow one with `npm run test:mutation -- --mutate "agent/workflows/refill.ts"`. The
command runner cannot do per-test coverage, so untested code shows as survivors rather
than `NoCoverage`. There is no CI workflow in this repository.

## Mock

`npm run mock` starts `mock/app.ts`. Dataset selection is `DATASET_PATH`, then
`mock/dataset.json`, then the development seed; `SIM_NOW` overrides the clock. Refill
POSTs are accepted for any medication on the record and change nothing, and
unauthorized requests are rejected before being recorded. `mock/server.ts` composes
parsing (`http.ts`), authorization, recording (`state.ts`), routes (`ehr.ts`), and
harness faults (`faults.ts`).

## Code style

Prettier (`.prettierrc.json`) formats TypeScript, JSON, and Markdown: two-space
indentation, double quotes, semicolons, trailing commas, 80 columns. Generated files,
the lockfile, and AI transcripts are excluded. Functions stay small and named for their
intent so orchestration reads as a sequence of domain steps; private helpers stay in
their owning module.

## Known limitations

- No live model run has validated the refill workflow; unit tests use simulated model
  output, and the interpreter prompt still needs live conformance and transcript review.
- State and the submission ledger are in memory and lost on restart.
- Escalation sets the `escalated` state with fixed handoff wording; no external
  handoff or ticket is created, and no structured audit record is written.
- Refill-phase clarifications use fixed wording rather than model phrasing.
- Patient-supplied identity details are sent to OpenAI for extraction.
