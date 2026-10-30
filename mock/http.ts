import type { IncomingMessage, ServerResponse } from "node:http";

export interface MockRequest {
  method: string;
  path: string;
  segments: string[];
  query: URLSearchParams;
  body: any;
}

export interface MockResponse {
  status: number;
  body: unknown;
}

export async function readRequest(req: IncomingMessage): Promise<MockRequest> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  return {
    method,
    path: url.pathname,
    segments: url.pathname.split("/").filter(Boolean),
    query: url.searchParams,
    body:
      method === "POST" || method === "PUT" ? await readBody(req) : undefined,
  };
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

export function sendResponse(
  res: ServerResponse,
  { status, body }: MockResponse,
) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
