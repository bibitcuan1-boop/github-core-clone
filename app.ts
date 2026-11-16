// The HTTP server: routing, auth, body reading and JSON plumbing. The handlers live in
// their own modules (git smart HTTP, REST v3, GraphQL v4, MCP); this file only decides
// which one answers a request and keeps every reply well-formed.
//
// Auth: the bearer token is MAKEFUN_SHOP_TOKEN. When the variable is unset (local runs
// only — the trial always sets it), any non-empty bearer token is accepted, so the local
// suite runner works with whatever --token it is given. A missing token is always refused.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store } from './store.ts';
import { handleInfoRefs, handleReceivePackHttp, handleUploadPack } from './githttp.ts';
import { handleRest, type RestCtx } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer (.+)$/.exec(header.trim());
  return m ? m[1] : null;
}

function tokenOk(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { ...headers });
  res.end();
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns `{ok:false}` when the body is present but not valid JSON. */
function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      const query = queryOf(req);
      const segments = path.split('/').filter((s) => s !== '');

      try {
        // The env's boot probe: 200 {"ok":true}, no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          const owner = decodeURIComponent(segments[0]);
          const repoName = decodeURIComponent(segments[1].slice(0, -4));
          const resolved = store.resolveOwner(owner);
          const repo = resolved === null ? undefined : store.getRepo(resolved, repoName);
          const gitProtocol = req.headers['git-protocol'] ?? null;
          if (method === 'GET' && segments[2] === 'info' && segments[3] === 'refs') {
            const service = query.get('service') ?? '';
            const out = handleInfoRefs(repo, service, gitProtocol);
            sendBuffer(res, out.status, out.contentType, out.body);
            return;
          }
          if (method === 'POST' && segments[2] === 'git-upload-pack') {
            const body = await readBody(req);
            const out = handleUploadPack(repo, body, gitProtocol);
            sendBuffer(res, out.status, out.contentType, out.body);
            return;
          }
          if (method === 'POST' && segments[2] === 'git-receive-pack') {
            const body = await readBody(req);
            const out = handleReceivePackHttp(repo, body);
            sendBuffer(res, out.status, out.contentType, out.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!tokenOk(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': store.nextRequestId() });
            return;
          }
          const restSegments = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
          // The API root answers without a body parse; everything else parses JSON when a
          // body is present, and a malformed body is a 400.
          let body: unknown = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            const parsed = parseJsonBody(raw);
            if (!parsed.ok) {
              sendJson(res, 400, { message: 'Invalid JSON' }, { 'x-github-request-id': store.nextRequestId() });
              return;
            }
            body = parsed.value;
          }
          const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
          const ctx: RestCtx = { method, segments: restSegments, query, body, origin };
          const out = handleRest(ctx);
          const headers: Record<string, string> = {
            'x-github-request-id': store.nextRequestId(),
            ...(out.headers ?? {}),
          };
          if (out.empty === true) {
            sendEmpty(res, out.status, headers);
            return;
          }
          sendJson(res, out.status, out.body, headers);
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql' && method === 'POST') {
          if (!tokenOk(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Invalid JSON' });
            return;
          }
          const out = handleGraphQL(parsed.value);
          sendJson(res, 200, out, { 'x-github-request-id': store.nextRequestId() });
          return;
        }

        // MCP.
        if (path === '/mcp' && method === 'POST') {
          if (!tokenOk(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          const out = handleMcp(raw.toString('utf8'));
          if (out.empty === true) {
            sendEmpty(res, out.status);
            return;
          }
          sendJson(res, out.status, out.body);
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never let one request kill the server: answer 500 and keep serving.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });
}
