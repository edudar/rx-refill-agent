# Build Assessment — Prescription-Refill Agent

Thanks for taking this on. You'll use an AI coding agent to build a **locally-running agentic
system that handles patient prescription-refill requests** over a chat interface. We provide a
mock EHR and pharmacy service; you build the agent that talks to patients and to those services.

We care about **how you wield AI to build something that behaves correctly and safely in the
real world** — not about lines of code. Bring your judgment.

## Your agent's job

A patient messages your agent asking to refill a prescription. Across the conversation, your
agent should:

1. **Authenticate the patient** through the chat "front door."
2. **Determine the patient's need** with respect to the refill.
3. **Enforce the clinical rules** for certain medications (see `docs/API.md` §4).
4. **Confirm the patient's pharmacy.**
5. **Handle a change of pharmacy** if the patient wants one.

## What we provide
- **Mock EHR + pharmacy services** (`npm run mock`) with visible dev seed data you can inspect
  in `mock/`. *(This is sample development data; your agent should work for any patients/records
  of this shape, not just these specific ones.)*
- **`docs/API.md`** — the conversation endpoint you implement, the EHR/pharmacy API you call,
  and the clinical rules to enforce. **Read it first.**
- **A skeleton agent** (`agent/`) — the conversation endpoint wired up, returning a placeholder.
  Build your logic there, or replace it (any stack, as long as it implements the endpoint).
- **A conformance check** (`npm run conformance`) — confirms your agent is drivable by our
  grader. Passing it is necessary, not sufficient.

## Getting started
```
npm install
npm run mock          # EHR + pharmacy on :4010
npm run agent         # your agent on :5050 (skeleton — start building)
npm run conformance   # run mock + agent first, then this
```

## How you're evaluated
We run your agent through patient conversations and review your code, your `SUBMISSION.md`, and
your session transcript. We care about how well the system works for real patients and how you
used AI to build it. Build it the way you'd want a real patient-facing system to work.

## What to submit
1. **Your agent** — implements the conversation endpoint, runs locally, and **starts with a single
   documented command**, reading all model credentials/config from **environment variables** (do
   **not** hardcode keys). We run your agent ourselves to evaluate it, so it must start from env
   config alone. `npm run conformance` should pass.
2. **Your own tests / notes on how you thought about failure and safety** — this is where your
   judgment shows.
3. **A short `SUBMISSION.md`** — the exact run command, the env vars it needs, key design
   decisions, and **which model + version you used** (provider + model id), so we can reproduce
   your run with our own credentials. Use a commercially-available API model.
4. **Your full AI session transcript(s)** in `docs/ai-log/`.
5. **Git history** — commit as you go.

### How to deliver
You've been given access to a **private GitHub repository** for this assessment — only you and the
reviewing team can see it. Commit as you go and **push to that repo**: your agent code, `SUBMISSION.md`,
and your transcript under `docs/ai-log/`. When you're finished, reply to let us know.
Deadline and questions: **_[to be filled in]_**.

## Ground rules
- Using an AI agent is required — that's the point. You must understand and stand behind what
  you ship; we may ask you to walk through any part of it.
- All data here is synthetic. No real PHI is involved.
- **Suggested time box:** a focused half-day.
