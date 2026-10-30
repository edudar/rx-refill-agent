// Mock EHR + Pharmacy services (dependency-free Node HTTP). Implements the documented API shapes
// (see docs/API.md).
//
//   npm run mock            # serves /ehr/* and /pharmacy/* on PORT (default 4010)
//
// Auth: the agent presents a static service bearer token (EHR_API_KEY / PHARMACY_API_KEY). This
// authorizes the agent to the EHR service; it is not a patient login.
//
// Local introspection: POST /__reset restores the initial dataset and clears all run state;
// GET /__calls returns requests recorded since the last reset, including rejected refills.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import type { Dataset } from "./types.js";

dayjs.extend(utc);

interface CallRecord {
  seq: number;
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
const last4 = (phone: string): string => phone.replace(/\D/g, "").slice(-4);
const authOk = (req: IncomingMessage, expected: string): boolean =>
  req.headers["authorization"] === `Bearer ${expected}`;

export function createMockServer(options: {
  dataset: Dataset;
  now?: string;
  ehrApiKey: string;
  pharmacyApiKey: string;
}) {
  // Never mutate the caller's fixture; keep a separate snapshot for every reset.
  const initialData = structuredClone(options.dataset);
  let data = structuredClone(initialData);
  const now = options.now ?? initialData.now;
  const today = dayjs.utc(now).startOf("day");
  if (!today.isValid()) throw new Error("Invalid simulated clock");
  let refillCounter = 0;
  let callLog: CallRecord[] = [];
  let callSeq = 0;

  return createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const seg = p.split("/").filter(Boolean);
    const body =
      method === "POST" || method === "PUT" ? await readBody(req) : undefined;

    // ---- Local introspection (used by the conformance check) ----
    if (p === "/__reset" && method === "POST") {
      data = structuredClone(initialData);
      refillCounter = 0;
      callLog = [];
      callSeq = 0;
      return send(res, 200, { ok: true });
    }
    if (p === "/__calls" && method === "GET") return send(res, 200, callLog);
    if (p === "/healthz") return send(res, 200, { ok: true });

    // ---- Auth gate by service prefix ----
    if (seg[0] === "ehr" && !authOk(req, options.ehrApiKey))
      return send(res, 401, { error: "unauthorized" });
    if (seg[0] === "pharmacy" && !authOk(req, options.pharmacyApiKey))
      return send(res, 401, { error: "unauthorized" });

    // Record each request (for the conformance check).
    if (seg[0] === "ehr" || seg[0] === "pharmacy") {
      callLog.push({
        seq: ++callSeq,
        method,
        path: p,
        query: Object.fromEntries(url.searchParams),
        body,
      });
    }

    // ---- EHR ----
    if (p === "/ehr/time" && method === "GET") return send(res, 200, { now });

    if (p === "/ehr/patients:match" && method === "POST") {
      if (body === null) return send(res, 400, { error: "invalid json" });
      const provided = Object.entries(body?.factors ?? {}).filter(
        ([, v]) => v !== undefined && v !== null && v !== "",
      );
      const matches = data.patients.filter((pt) =>
        provided.every(([k, v]) => {
          const val = String(v);
          switch (k) {
            case "firstName":
              return pt.firstName.toLowerCase() === val.toLowerCase();
            case "lastName":
              return pt.lastName.toLowerCase() === val.toLowerCase();
            case "dob":
              return pt.dob === val;
            case "phoneLast4":
              return last4(pt.phone) === val;
            case "zip":
              return pt.zip === val;
            default:
              return false;
          }
        }),
      );
      return send(res, 200, {
        count: matches.length,
        patientId: matches.length === 1 ? matches[0].patientId : null,
      });
    }

    if (seg[0] === "ehr" && seg[1] === "patients" && seg[2]) {
      const pt = data.patients.find((patient) => patient.patientId === seg[2]);
      if (!pt) return send(res, 404, { error: "patient not found" });
      if (seg.length === 3 && method === "GET") {
        return send(res, 200, {
          patientId: pt.patientId,
          firstName: pt.firstName,
          lastName: pt.lastName,
          dob: pt.dob,
          phone: pt.phone,
          zip: pt.zip,
        });
      }
      if (seg[3] === "medications" && seg.length === 4 && method === "GET")
        return send(res, 200, pt.medications);
      if (seg[3] === "labs" && seg.length === 4 && method === "GET") {
        const type = url.searchParams.get("type");
        return send(
          res,
          200,
          type
            ? pt.labs.filter((l) => l.type.toLowerCase() === type.toLowerCase())
            : pt.labs,
        );
      }
      if (seg[3] === "pharmacy" && seg.length === 4) {
        if (method === "GET") {
          const ph =
            data.pharmacies.find(
              (x) => x.pharmacyId === pt.currentPharmacyId,
            ) ?? null;
          return send(
            res,
            200,
            ph ? { pharmacyId: ph.pharmacyId, name: ph.name } : null,
          );
        }
        if (method === "PUT") {
          if (body === null || !body.pharmacyId)
            return send(res, 400, { error: "pharmacyId required" });
          if (!data.pharmacies.some((x) => x.pharmacyId === body.pharmacyId))
            return send(res, 404, { error: "pharmacy not found" });
          pt.currentPharmacyId = body.pharmacyId;
          return send(res, 200, { ok: true });
        }
      }
      if (seg[3] === "refills" && seg.length === 4 && method === "POST") {
        if (body === null || !body.medId)
          return send(res, 400, { error: "medId required" });
        const medication = pt.medications.find((m) => m.medId === body.medId);
        if (!medication)
          return send(res, 404, { error: "medication not found" });

        // Independent mock backstop. The agent must reject these before attempting POST.
        const reject = (code: string) => send(res, 409, { error: code });
        if (medication.schedule === "CII") return reject("schedule_ii");
        if (medication.refillsRemaining <= 0) return reject("no_refills");
        if (dayjs.utc(medication.rxExpirationDate).isBefore(today))
          return reject("prescription_expired");
        if (
          medication.schedule &&
          ["CIII", "CIV", "CV"].includes(medication.schedule) &&
          today.isBefore(
            dayjs
              .utc(medication.lastFilledDate)
              .add(medication.daysSupply, "day")
              .subtract(2, "day"),
          )
        )
          return reject("controlled_refill_too_early");
        const requiredLab = medication.requiresRecentLab;
        if (
          requiredLab &&
          !pt.labs.some((lab) => {
            const taken = dayjs.utc(lab.takenDate);
            return (
              taken.isValid() &&
              lab.type.toLowerCase() === requiredLab.type.toLowerCase() &&
              !taken.isAfter(today) &&
              !taken.isBefore(today.subtract(requiredLab.withinDays, "day"))
            );
          })
        )
          return reject("recent_lab_required");

        medication.refillsRemaining--;
        // A submitted request is not a dispensed fill: lastFilledDate stays unchanged.
        return send(res, 200, {
          refillId: `rf_${++refillCounter}`,
          status: "submitted",
        });
      }
    }

    // ---- Pharmacy ----
    if (p === "/pharmacy/directory" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return send(
        res,
        200,
        data.pharmacies.filter(
          (ph) =>
            !q ||
            ph.name.toLowerCase().includes(q) ||
            ph.address.toLowerCase().includes(q),
        ),
      );
    }

    return send(res, 404, { error: "not found", method, path: p });
  });
}
