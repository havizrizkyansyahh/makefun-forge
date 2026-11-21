// Hand-rolled HTTP/1.1 transport: a raw socket, a bounded parser, one write per response.
// The handlers keep their res.writeHead/res.end shape; this shim serialises it to a single buffer.
import { createServer, type Server, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';

const MAX_HEAD = 64 * 1024;
const MAX_BODY = 300 * 1024 * 1024;

interface FakeReq extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  socket: Socket;
  body: Buffer;
}

let idSeq = 0;
const nextId = (): string => `req-${(++idSeq).toString(36)}-${(Date.now() % 100000).toString(36)}`;

function serialise(status: number, headers: Record<string, string>, body: Buffer): Buffer {
  const lines: string[] = [`HTTP/1.1 ${status} ${STATUS[status] ?? 'OK'}`];
  if (!('x-github-request-id' in headers)) headers['x-github-request-id'] = nextId();
  headers['content-length'] = String(body.length);
  headers.connection = 'keep-alive';
  for (const k of Object.keys(headers)) lines.push(`${k}: ${headers[k]}`);
  return Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), body]);
}

const STATUS: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized',
  404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 413: 'Payload Too Large', 422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

export interface Res {
  statusCode: number;
  headers: Record<string, string>;
  writeHead(status: number, headers?: Record<string, string>): void;
  setHeader(name: string, value: string): void;
  write(chunk: Buffer | string): void;
  end(chunk?: Buffer | string): void;
  headersSent: boolean;
  writableEnded: boolean;
}

function makeRes(sock: Socket): Res {
  const res: Res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) { res.statusCode = status; if (headers) Object.assign(res.headers, headers); res.headersSent = true; },
    setHeader(name, value) { res.headers[name.toLowerCase()] = value; },
    write(chunk) { parts.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk); },
    end(chunk) {
      if (chunk) parts.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      res.writableEnded = true;
      const body = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      sock.write(serialise(res.statusCode, res.headers, body));
      parts = [];
    },
  };
  let parts: Buffer[] = [];
  return res;
}

export type Handler = (req: FakeReq, res: Res) => void;

export function createTransport(handler: Handler): Server {
  return createServer((sock) => {
    sock.setNoDelay(true);
    let acc = Buffer.alloc(0);
    let busy = false;

    const pump = (): void => {
      if (busy) return;
      for (;;) {
        const headEnd = acc.indexOf('\r\n\r\n');
        if (headEnd < 0) {
          if (acc.length > MAX_HEAD) sock.destroy();
          return;
        }
        const head = acc.subarray(0, headEnd).toString('latin1');
        const eol = head.indexOf('\r\n');
        const requestLine = (eol < 0 ? head : head.slice(0, eol)).split(' ');
        const method = requestLine[0] ?? 'GET';
        const url = requestLine[1] ?? '/';
        const headers: Record<string, string | undefined> = {};
        if (eol >= 0) {
          for (const line of head.slice(eol + 2).split('\r\n')) {
            const i = line.indexOf(':');
            if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
          }
        }
        const length = Number(headers['content-length'] ?? 0);
        const need = headEnd + 4 + (Number.isFinite(length) ? length : 0);
        if (acc.length < need) return;
        const body = acc.subarray(headEnd + 4, need);
        acc = acc.subarray(need);
        if (chunked(headers)) { /* git never chunks; treat as best effort */ }
        const req = new EventEmitter() as FakeReq;
        req.method = method; req.url = url; req.headers = headers; req.socket = sock; req.body = body;
        const res = makeRes(sock);
        busy = true;
        handler(req, res);
        busy = false;
        if (sock.destroyed) return;
      }
    };

    sock.on('data', (d) => {
      acc = acc.length ? Buffer.concat([acc, d]) : d;
      if (acc.length > MAX_BODY) { sock.destroy(); return; }
      pump();
    });
    sock.on('error', () => { /* client went away */ });
  });
}

function chunked(headers: Record<string, string | undefined>): boolean {
  return /chunked/i.test(headers['transfer-encoding'] ?? '');
}
