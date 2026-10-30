import { createServer, type ServerResponse } from "node:http";
import {
  patientMessageSchema,
  type TurnHandler,
} from "./contracts/conversation.js";

export function createAgentServer(handleTurn: TurnHandler) {
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
  };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz" && req.method === "GET")
        return send(res, 200, { ok: true });
      const match = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
      if (!match || req.method !== "POST")
        return send(res, 404, { error: "not found" });
      if (match[1].length > 200)
        return send(res, 400, { error: "conversation ID is too long" });
      let raw = "";
      let bytes = 0;
      req.setEncoding("utf8");
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16_384)
          return send(res, 413, { error: "message is too large" });
        raw += chunk;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "invalid JSON" });
      }
      const message = patientMessageSchema.safeParse(body);
      if (!message.success)
        return send(res, 400, {
          error:
            'Expected { "from": "patient", "text": "non-empty text up to 2000 characters" }',
        });
      return send(res, 200, await handleTurn(match[1], message.data.text));
    } catch {
      return send(res, 500, { error: "Unable to process message" });
    }
  });
}
