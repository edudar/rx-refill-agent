# API reference

Two things you interact with:

1. **The conversation endpoint** — *you implement this*. The grader (and the conformance check)
   talks to your agent here.
2. **The EHR + Pharmacy services** — *provided* (`npm run mock`). Your agent calls these to read
   patient data and take actions.

All services are local HTTP. Config comes from env (see `.env` usage in the skeleton):
`EHR_BASE_URL`, `PHARMACY_BASE_URL`, `EHR_API_KEY`, `PHARMACY_API_KEY`. Defaults point at the
local mock.

---

## 1. Conversation endpoint (you implement)

```
POST /conversations/{conversationId}/messages
  req:  { "from": "patient", "text": "<patient message>" }
  res:  { "messages": [ { "from": "agent", "text": "<reply>" } ],
          "state": "in_progress" | "complete" | "escalated" }

GET  /healthz  ->  200 when ready
```
- You receive patient messages one at a time for a `conversationId` and return your agent's
  reply turn(s). Maintain per-conversation state keyed by `conversationId`.
- `state`: `in_progress` (you expect more), `complete` (request resolved), `escalated` (you're
  handing off to a human/pharmacist and stopping).
- The skeleton in `agent/` wires this up and returns a placeholder — build your logic there (or
  replace it entirely; any stack is fine as long as it implements this endpoint).

---

## 2. EHR service (provided)

Send `Authorization: Bearer ${EHR_API_KEY}` on every call. This authorizes your agent to the EHR
service; it is **not** a patient login. Verifying which patient you're actually talking to (your
goal #1) is your application's job — use `:match` for that.

```
GET  /ehr/time                                 -> { "now": "<ISO8601>" }   // simulated clock (fixed)
POST /ehr/patients:match                       req { "factors": { firstName?, lastName?, dob?, phoneLast4?, zip? } }
                                               -> { "count": <int>, "patientId": <string>|null }   // patientId only when count === 1
GET  /ehr/patients/{patientId}                 -> { patientId, firstName, lastName, dob, phone, zip }
GET  /ehr/patients/{patientId}/medications     -> [ Medication ]
GET  /ehr/patients/{patientId}/labs?type=<t>   -> [ { type, value, takenDate } ]
GET  /ehr/patients/{patientId}/pharmacy        -> { pharmacyId, name } | null
PUT  /ehr/patients/{patientId}/pharmacy        req { "pharmacyId" } -> { "ok": true }
POST /ehr/patients/{patientId}/refills         req { "medId" } -> { "refillId", "status": "submitted" }
```

`:match` is an identity-matching primitive: it tells you whether the factors you pass uniquely
resolve to a patient (and never returns demographic data). How many factors to require, and how
to handle no-match / ambiguous-match, is your design.

`Medication`:
```
{ "medId", "name", "isControlled": bool, "schedule": "CII".."CV"|null,
  "lastFilledDate", "daysSupply": int, "refillsRemaining": int, "rxExpirationDate",
  "requiresRecentLab": { "type": "<lab>", "withinDays": int } | null }
```

Use `GET /ehr/time` as "now" for any date logic (it's fixed per run, so your behavior is
reproducible).

---

## 3. Pharmacy service (provided)

Send `Authorization: Bearer ${PHARMACY_API_KEY}`.
```
GET /pharmacy/directory?q=<search>  -> [ { pharmacyId, name, address } ]
```
The patient's *current* pharmacy and changes are on the EHR patient record (§2).

---

## 4. Clinical rules you must enforce

The EHR does **not** enforce these — your agent must. Evaluate against `GET /ehr/time`.

- **R1 — Schedule II:** meds with `schedule === "CII"` are **not refillable** here → decline and
  escalate to the prescriber.
- **R2 — No refills / expired:** if `refillsRemaining === 0` **or** `rxExpirationDate` is past
  `now` → decline and escalate for a new prescription.
- **R3 — Controlled early-refill (CIII–CV):** decline if `now` is more than **2 days** before
  the current supply runs out (`lastFilledDate + daysSupply`).
- **R4 — Required recent lab:** if `requiresRecentLab` is set, a lab of that `type` must exist
  within `withinDays` of `now`; otherwise hold and advise/escalate.

---

## 5. Running things
```
npm install
npm run mock          # EHR + pharmacy on :4010
npm run agent         # your agent on :5050 (skeleton to start)
npm run conformance   # checks your agent is drivable (run mock + agent first)
```
