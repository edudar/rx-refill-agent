// Mock EHR + Pharmacy services (dependency-free Node HTTP). Implements the documented API shapes
// (see docs/API.md).
//
//   npm run mock            # serves /ehr/* and /pharmacy/* on PORT (default 4010)
//
// Auth: the agent presents a static service bearer token (EHR_API_KEY / PHARMACY_API_KEY). This
// authorizes the agent to the EHR service; it is not a patient login.
//
// Local introspection (used by the conformance check): POST /__reset clears the recorded-request
// log; GET /__calls returns the requests recorded since the last reset.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Dataset, Patient } from "./types.js";
import { devDataset } from "./data.dev.js";

const PORT = Number(process.env.PORT ?? 4010);
const EHR_API_KEY = process.env.EHR_API_KEY ?? "dev-ehr-key";
const PHARMACY_API_KEY = process.env.PHARMACY_API_KEY ?? "dev-pharmacy-key";

// Dataset: DATASET_PATH env > a local mock/dataset.json > the built-in dev seed.
function loadDataset(): Dataset {
  const localJson = fileURLToPath(new URL("./dataset.json", import.meta.url));
  const path =
    process.env.DATASET_PATH ?? (existsSync(localJson) ? localJson : null);
  if (path) {
    console.log(`loading dataset from ${path}`);
    return JSON.parse(readFileSync(path, "utf8"));
  }
  return devDataset;
}
const data: Dataset = loadDataset();
const now = process.env.SIM_NOW ?? data.now;

let refillCounter = 0;
interface CallRecord {
  seq: number;
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}
let callLog: CallRecord[] = [];
let callSeq = 0;

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
const findPatient = (id: string): Patient | undefined =>
  data.patients.find((p) => p.patientId === id);
const authOk = (req: IncomingMessage, expected: string): boolean =>
  req.headers["authorization"] === `Bearer ${expected}`;

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const seg = p.split("/").filter(Boolean);
  const body =
    method === "POST" || method === "PUT" ? await readBody(req) : undefined;

  // ---- Local introspection (used by the conformance check) ----
  if (p === "/__reset" && method === "POST") {
    callLog = [];
    callSeq = 0;
    return send(res, 200, { ok: true });
  }
  if (p === "/__calls" && method === "GET") return send(res, 200, callLog);
  if (p === "/healthz") return send(res, 200, { ok: true });

  // ---- Auth gate by service prefix ----
  if (seg[0] === "ehr" && !authOk(req, EHR_API_KEY))
    return send(res, 401, { error: "unauthorized" });
  if (seg[0] === "pharmacy" && !authOk(req, PHARMACY_API_KEY))
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
    const pt = findPatient(seg[2]);
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
          data.pharmacies.find((x) => x.pharmacyId === pt.currentPharmacyId) ??
          null;
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
      if (!pt.medications.some((m) => m.medId === body.medId))
        return send(res, 404, { error: "medication not found" });
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

server.listen(PORT, () => {
  console.log(
    `mock EHR+pharmacy on http://localhost:${PORT}  (sim now=${now})`,
  );
  console.log(
    `  EHR_API_KEY=${EHR_API_KEY}  PHARMACY_API_KEY=${PHARMACY_API_KEY}`,
  );
});
