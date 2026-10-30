import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  patientMessageSchema,
  type TurnHandler,
} from "./contracts/conversation.js";

interface RequestFailure {
  status: number;
  error: string;
}

type ParsedMessage = { text: string } | RequestFailure;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export function createAgentServer(handleTurn: TurnHandler) {
  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/healthz" && req.method === "GET")
        return send(res, 200, { ok: true });
      const match = path.match(/^\/conversations\/([^/]+)\/messages$/);
      if (!match || req.method !== "POST")
        return send(res, 404, { error: "not found" });
      if (match[1].length > 200)
        return send(res, 400, { error: "conversation ID is too long" });
      const message = await readPatientMessage(req);
      if ("error" in message)
        return send(res, message.status, { error: message.error });
      return send(res, 200, await handleTurn(match[1], message.text));
    } catch {
      return send(res, 500, { error: "Unable to process message" });
    }
  });
}

async function readPatientMessage(
  req: IncomingMessage,
): Promise<ParsedMessage> {
  const raw = await readLimitedBody(req);
  if (typeof raw !== "string") return raw;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400, error: "invalid JSON" };
  }
  const message = patientMessageSchema.safeParse(body);
  if (!message.success)
    return {
      status: 400,
      error:
        'Expected { "from": "patient", "text": "non-empty text up to 2000 characters" }',
    };
  return { text: message.data.text };
}

async function readLimitedBody(
  req: IncomingMessage,
): Promise<string | RequestFailure> {
  let raw = "";
  let bytes = 0;
  req.setEncoding("utf8");
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16_384) return { status: 413, error: "message is too large" };
    raw += chunk;
  }
  return raw;
}
