// The forge: one HTTP server over store, git smart HTTP, REST v3, GraphQL v4 and MCP.
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createTransport } from './transport.ts';

import * as S from './store.ts';
import * as Git from './gitsrv.ts';
import { handle as handleRest, json, err } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function readBody(req: IncomingMessage): Promise<Buffer> {
  const carried = (req as unknown as { body?: Buffer }).body;
  return Promise.resolve(carried ?? Buffer.alloc(0));
}

let idSeq = 0;
const nextId = (): string => `req-${(++idSeq).toString(36)}-${(Date.now() % 100000).toString(36)}`;

export function createApp(): Server {
  return createTransport((req, res) => {
    serve(req as unknown as IncomingMessage, res as unknown as ServerResponse).catch((e: Error) => {
      process.stderr.write(`serve error ${req.method} ${req.url}: ${e.stack ?? e.message}\n`);
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"message":"Internal Server Error"}'); } else res.end();
    });
  }) as unknown as Server;
}

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const t0 = Date.now();
  if (process.env.TRACE) res.on('finish', () => { if (process.env.TRACE) process.stderr.write(`[${req.method} ${req.url} ${res.statusCode} ${Date.now() - t0}ms te=${req.headers['transfer-encoding'] ?? '-'} cl=${req.headers['content-length'] ?? '-'} expect=${req.headers.expect ?? '-'}]\n`); });
  if (process.env.TRACE) res.on('close', () => { if (!res.writableEnded) process.stderr.write(`[closed early ${req.method} ${req.url}]\n`); });
  let path = '/';
  let parsed: URL | null = null;
  try { parsed = new URL(req.url ?? '/', 'http://entry'); path = parsed.pathname; } catch { /* keep '/' */ }
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') { json(res, 200, { ok: true }); return; }

  const auth = String(req.headers.authorization ?? '');
  const tokenOk = TOKEN === '' ? true : auth === `Bearer ${TOKEN}`;

  // git smart HTTP: /{owner}/{repo}.git/...
  const gi = path.match(/^\/api\/v3\/repos\/([^/]+)\//);
  if (gi) S.noteOwner(decodeURIComponent(gi[1]));
  const git = path.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)$/);
  if (git) S.noteOwner(decodeURIComponent(git[1]));
  if (git) {
    const repo = S.findRepo(decodeURIComponent(git[1]), decodeURIComponent(git[2]));
    const tail = git[3];
    if (tail === '/info/refs') {
      const service = String(new URL(req.url ?? '/', 'http://x').searchParams.get('service') ?? '');
      if (service === 'git-upload-pack') return Git.infoRefs(req, res, repo, 'upload');
      if (service === 'git-receive-pack') return Git.infoRefs(req, res, repo, 'receive');
      res.writeHead(404); res.end('unknown service\n'); return;
    }
    if (tail === '/git-upload-pack') return Git.uploadPack(req, res, repo);
    if (tail === '/git-receive-pack') return Git.receivePack(req, res, repo);
    err(res, 404, 'Not Found'); return;
  }

  const isApi = path.startsWith('/api/v3') || path === '/api/graphql' || path === '/mcp';
  let body = Buffer.alloc(0);
  if (isApi && method !== 'GET') {
    try { body = await readBody(req); } catch { err(res, 413, 'Payload Too Large'); return; }
  }
  if (isApi && body.length && (method === 'POST' || method === 'PUT' || method === 'PATCH') && path !== '/mcp') {
    try { JSON.parse(body.toString()); } catch {
      if (!path.startsWith('/mcp')) { err(res, 400, 'Problems parsing JSON'); return; }
    }
  }
  if (path === '/mcp') { await handleMcp(req, res, body, tokenOk); return; }
  if (path === '/api/graphql') { await handleGraphQL(req, res, body, tokenOk); return; }
  if (path.startsWith('/api/v3')) {
    if (!tokenOk) { err(res, 401, 'Requires authentication'); return; }
    const handled = await handleRest({ req, res, body, url: parsed, base: `http://${req.headers.host ?? 'localhost'}` }, method, path);
    if (!handled) err(res, 404, 'Not Found');
    return;
  }
  err(res, 404, 'Not Found');
}
