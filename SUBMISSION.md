# Submission

## Documentation policy

`README.md` preserves the original assessment instructions from the starter commit
(`80f19f7`). Do not edit or reformat it. Record project changes, setup instructions,
commands, architecture, implementation guidance, and limitations in `SUBMISSION.md`.
The original README is excluded from Prettier to preserve it exactly.

## How to run

Requires Node.js 22 or newer. If you use nvm, run `nvm install` and `nvm use`
to select the Node.js 22 baseline from `.nvmrc`.

```
npm install
npm run typecheck     # check agent, mock, and conformance TypeScript without emitting files
npm test              # automated tests; no API credentials required
npm run mock          # EHR + pharmacy on :4010
npm run agent         # agent on :5050; export OpenAI configuration first (see below)
npm run conformance   # all conformance scenarios; run mock + agent first
```

## OpenAI configuration

Set `OPENAI_API_KEY` and `OPENAI_MODEL` in the agent process environment. Choose a
model available to your account that supports Responses API Structured Outputs.
The agent has no default model and fails at startup if either variable is missing.
Optionally set `OPENAI_REASONING_EFFORT` to `none`, `minimal`, `low`, `medium`,
`high`, `xhigh`, or `max`. If unset, the request omits reasoning configuration and
uses the model's default. Invalid values fail at startup; the selected model must
support the requested effort. For Luna identity extraction, start with `none`.
`AGENT_PORT`, `EHR_BASE_URL`, and `EHR_API_KEY` are optional overrides; their defaults
connect to the local mock.

Alternatively, copy `.env.openai` to `.env`, replace the placeholders, and start
with `node --env-file=.env --import=tsx agent/app.ts`. `.env` files are ignored by
Git. `npm run agent` reads exported environment variables and does not load `.env`.

- Model provider + model id + version: OpenAI Responses API; set the desired model
  ID/version using `OPENAI_MODEL`. No live model run has been validated yet.
- Settings: Structured Outputs, `store: false`, 512 maximum output tokens,
  15-second model timeout, no automatic model retries.
  Reasoning effort is selected through `OPENAI_REASONING_EFFORT`; when unset,
  the model's default applies.

## Authentication implementation

The current agent requires full name, date of birth, and five-digit ZIP code,
collected across messages. Phone last four digits are optional; if supplied, they
are validated and included in matching and record verification. Missing or invalid
required fields prevent EHR matching; invalid supplied phone digits prompt a correction.

Patients can provide DOB using month names or abbreviations (`March 12, 1988`,
`12 Mar 1988`), year-first dates (`1988-03-12`, `1988/3/12`), or unambiguous
month/day or day/month numeric dates (`12/31/1988`, `31/12/1988`). Dates are normalized
to ISO internally for EHR matching. The extraction model preserves the patient's
date format; Day.js with `CustomParseFormat` performs strict parsing and calendar
validation against explicit formats. The DOB wrapper tries every supported format
and accepts only one distinct result, rather than choosing the first matching
format. Ambiguous numeric dates
such as `03/04/1988`, two-digit years, or impossible dates trigger a request to spell
out the month. No locale is inferred from ZIP code or phone number. Initial prompts
ask for DOB without requiring a particular format.

Authentication follow-ups acknowledge newly accepted details by field name, ask
only for outstanding details, and join lists with "and." The existing extraction
call also classifies the message topic, allowing a pharmacy confirmation to be
acknowledged and deferred until verification rather than treated as identity data.
No additional model call is used. Prompts and the verification gate remain controlled
by application code; topic classification cannot authorize a pharmacy change or refill.
Repeated unanswered requests explain what is still missing and then offer the care
team as an option, without discarding collected details or claiming a handoff occurred.

It fetches a patient record only after a unique match, requesting phone last four
digits if needed to disambiguate. Three failed match attempts stop the conversation with a
care-team handoff message; no external handoff integration is implemented yet.

OpenAI extracts identity fields using
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
The application validates those fields and controls EHR access. The model has no
tools, receives no retrieved patient record, and cannot declare identity verified.
The extraction request uses `store: false`; identity details supplied in chat are
still sent to OpenAI for extraction. Unrelated requests receive a fixed redirect.

Conversation state is held in memory and is discarded on restart. Cleanup runs
before each turn: conversations expire 24 hours after creation, even if recently
active. The store retains at most 100 conversations, evicting the least recently
used idle conversation when a new ID would exceed that limit. In-flight turns
are protected; if all 100 conversations are busy, new conversations are temporarily
rejected. Returning to an evicted or expired ID starts fresh and requires identity
verification again. Each conformance scenario uses a fresh UUID per run.
This is the assessment's demographic matching flow;
it does not implement OTP or proof of possession. Conversation IDs are assumed
to be supplied by a trusted chat front end.

Authentication leaves the conversation `in_progress`. Medication selection,
clinical rules, pharmacy confirmation, and refill submission remain unimplemented,
so the full-refill happy-path scenario is not expected to pass yet. Unit tests use
simulated model/EHR responses and cover partial details, corrections, invalid
values, ambiguous/no matches, isolation, expiration, concurrency, and failures.

## Conformance scenarios

`conformance/run.ts` is the single entry point for all live conformance checks.
Start the mock and agent first, then run:

```sh
npm run conformance                     # run every registered scenario
npm run conformance -- --list           # list scenarios without contacting services
npm run conformance -- happy-path       # run only the refill happy path
npm run conformance -- missing-zip      # refusal and unrelated replies without ZIP
```

`AGENT_BASE` and `MOCK_BASE` optionally override the default agent (`:5050`) and mock
(`:4010`) URLs. The runner verifies service readiness, runs scenarios sequentially,
resets the mock request log before each scenario, and assigns a fresh conversation
ID. It reports each scenario and an aggregate summary, continues after scenario
failures, and exits nonzero if any scenario fails. Run one suite at a time against
a mock instance because its request log is shared. Scenarios that send valid
patient messages use the configured model and incur API usage.

The current scenarios are `happy-path` (the original refill check, including
identity verification) and `missing-zip`. The latter supplies name, DOB, and optional
phone digits, then refuses ZIP, sends unrelated text, confirms a pharmacy prematurely,
and asks the agent to obtain ZIP from the patient record. After every turn it checks
that the request is not complete, the agent has not claimed verification/submission,
and no EHR or pharmacy calls have occurred. In-progress replies must identify ZIP as
missing; a terminal escalation is also acceptable. This scenario deliberately never
provides ZIP. It checks the safety boundary rather than exact response wording.
Authentication is checked as part of conversation scenarios;
there is no standalone authentication conformance command. HTTP routing, request
validation, and server error responses are covered by `agent/server.test.ts`, using
an injected turn handler without a model or EHR. These checks run with `npm test`
and are not conformance scenarios.

To add further missing-data, controlled-substance, conversation-hijacking, or other
scenarios, create a file in `conformance/scenarios/` exporting a `ConformanceScenario`
and register it in `conformance/scenarios/index.ts`. The shared context provides
`send`, `calls`, `check`, and the scenario's conversation ID. Scenarios
contain their script and assertions; readiness, transport validation, isolation,
and reporting stay in the runner and client. Scenario modules never exit the
process or run on import. These additional clinical/adversarial scenarios are
planned, not implemented yet.

## Module boundaries

- `agent/contracts/` owns HTTP conversation, identity-extraction, and EHR contracts.
  Zod schemas and their inferred TypeScript types live together.
- `agent/domain/` owns validated identity structures and internal conversation state.
  Raw extraction proposals remain separate from validated identity fields.
- `agent/config.ts` owns model and service configuration. `loadConfig(env)` reads
  the supplied environment only when called; importing the module has no startup effects.
- `agent/identity-extractor.ts` implements OpenAI extraction; `agent/ehr.ts`
  implements the EHR client; `agent/authentication.ts` enforces the identity workflow.
- `agent/authentication-prompts.ts` composes contextual authentication follow-ups
  using accepted fields, validation errors, message topic, and unanswered requests.
- `agent/conversation-handler.ts` owns conversation storage, expiration, turn
  serialization, terminal states, and routing. Authentication is one workflow step;
  a separate handler can continue the conversation after authentication.
- `agent/contracts/logging.ts` defines conversation log events, and
  `agent/conversation-logger.ts` writes them to the console.
- `agent/server.ts` defines the HTTP server. `agent/app.ts` is the startup entry point
  that loads configuration, wires the conversation handler and its dependencies,
  and starts listening. Contracts and domain modules do not import implementations.

## Conversation logging

Conversation logging is enabled by default. Start the agent in one terminal and
run `npm run conformance` in another to see the dialogue in the agent terminal.
Each turn produces a `patient_message` record followed by an `agent_reply` record.
Unexpected turn failures produce a `turn_error` record instead of a reply record.

Logs are JSON lines containing timestamps, conversation IDs, and turn IDs so
interleaved conversations can be followed independently. Replies include all agent
messages, conversation state, and processing duration in milliseconds. Message text
is included verbatim, so these logs contain the identity details supplied in chat.
Retrieved patient records, configuration, and exception contents are not logged.

Set `CONVERSATION_LOGGING=false` in the agent environment to disable these logs:

```sh
CONVERSATION_LOGGING=false npm run agent
```

Only `true` and `false` are accepted. Logs go to stdout; optionally save the agent
output while watching it with `npm run agent | tee /tmp/refill-agent.log`.
Logging failures do not change conversation responses.

## Code style

Prettier formats TypeScript, JSON, and Markdown with two-space indentation,
double quotes, semicolons, trailing commas, and an 80-column print width.
Settings are in `.prettierrc.json`; generated files, the npm lockfile, and AI
session transcripts are excluded through `.prettierignore`.

```sh
npm run format        # format the project in place
npm run format:check  # check formatting without changing files (suitable for CI)
npm run typecheck     # check TypeScript separately
```

## Notes to the reviewer

- Test files sit beside and match their production modules. `identity-extractor.test.ts`
  verifies OpenAI request configuration, strict structured output, parsing, refusal,
  and incomplete-response handling using simulated HTTP responses. `ehr.test.ts`
  verifies service authorization, routes, timeout-signal attachment, patient-ID
  encoding, and rejection of failed requests, invalid matches, and wrong patient IDs.
  These tests do not call live services or evaluate actual model extraction quality.
  `conformance/suite.test.ts` checks runner isolation, failure aggregation, and readiness
  using simulated HTTP responses. `server.test.ts` covers HTTP transport and input
  validation; conformance covers conversation behavior across turns.
- Run `npm test`, `npm run typecheck`, and `npm run format:check` for local checks.
  Tests simulate model and EHR responses. With OpenAI configuration and the mock
  and agent running, use `npm run conformance` for live scenario checks. The
  happy-path scenario will fail until the refill workflow is implemented.
