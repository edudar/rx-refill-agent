// Conformance check. Run your agent, then run this — it drives one scripted happy-path refill and
// checks your agent implements the conversation contract (see docs/API.md). It only confirms the
// basic request/response loop works; it does not check your logic — that's up to you.
//
//   npm run conformance            # AGENT_BASE defaults to http://localhost:5050
//
// Requires the mock running (npm run mock) so it can inspect the requests your agent made.

const MOCK = process.env.MOCK_BASE ?? "http://localhost:4010";
const AGENT = process.env.AGENT_BASE ?? "http://localhost:5050";

// A cooperative, scripted patient. (Alice = a happy-path seed patient: non-controlled, refills left.)
const SCRIPT = [
  "I'd like to refill my Lisinopril.",
  "Alice Nguyen, DOB 1988-03-12, phone ending 1234, zip 94107.",
  "Yes, keep my pharmacy.",
];

interface Call { seq: number; method: string; path: string; body?: any }

async function main() {
  const failures: string[] = [];
  const ok = (cond: boolean, msg: string) => { if (!cond) failures.push(msg); };

  // health
  try { const h = await fetch(`${AGENT}/healthz`); ok(h.ok, "agent /healthz did not return 200"); }
  catch { failures.push(`could not reach agent at ${AGENT} (is it running?)`); }
  try { await fetch(`${MOCK}/healthz`); } catch { failures.push(`could not reach mock at ${MOCK} (run: npm run mock)`); }
  if (failures.length) return report(failures);

  await fetch(`${MOCK}/__reset`, { method: "POST" });

  const convId = "conformance-1";
  let lastState = "in_progress";
  for (const text of SCRIPT) {
    const res = await fetch(`${AGENT}/conversations/${convId}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "patient", text }),
    });
    ok(res.ok, `agent returned HTTP ${res.status} for a message`);
    if (!res.ok) break;
    const data = await res.json();
    ok(Array.isArray(data.messages) && data.messages.length > 0, "agent reply missing messages[]");
    ok(typeof data.state === "string", "agent reply missing state");
    lastState = data.state ?? lastState;
  }

  const calls: Call[] = await (await fetch(`${MOCK}/__calls`)).json();
  const match = calls.find((c) => c.path === "/ehr/patients:match" && c.method === "POST");
  const meds = calls.find((c) => /^\/ehr\/patients\/[^/]+\/medications$/.test(c.path) && c.method === "GET");
  const refill = calls.find((c) => /^\/ehr\/patients\/[^/]+\/refills$/.test(c.path) && c.method === "POST");
  const pid = (c?: Call) => c?.path.split("/")[3];

  ok(lastState === "complete", `expected final state "complete", got "${lastState}"`);
  ok(!!match, "agent never called POST /ehr/patients:match (identity verification)");
  ok(!!meds, "agent never fetched the patient's medications");
  ok(!!refill, "agent never submitted a refill (POST /ehr/patients/{id}/refills)");
  if (match && refill) ok(refill.seq > match.seq, "agent submitted a refill BEFORE verifying identity (:match)");
  if (meds && refill) ok(pid(meds) === pid(refill), "agent refilled a different patient than it looked up");
  if (refill) ok(!!refill.body?.medId, "refill call had no medId in body");

  report(failures);
}

function report(failures: string[]) {
  if (failures.length === 0) { console.log("✅ CONFORMANCE PASSED — your agent implements the conversation contract."); process.exit(0); }
  console.log("❌ CONFORMANCE FAILED:");
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}

main();
