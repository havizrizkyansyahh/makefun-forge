// git smart HTTP: v2 advertisement/ls-refs/fetch (shallow, side-band) and v0 receive-pack.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';
import * as S from './store.ts';
import { ingestPack as ingest } from './pack.ts';

const FLUSH = Buffer.from('0000');
const REND = Buffer.from('0002');
const DELIM = Buffer.from('0001');
const CAPS_V2 = ['version 2', 'agent=makefun-forge/1.0', 'ls-refs', 'fetch=shallow', 'server-option', 'object-format=sha1'];
const ZERO = '0'.repeat(40);

function pkt(s: string | Buffer): Buffer {
  const body = typeof s === 'string' ? Buffer.from(s) : s;
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
}
function sideband(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < data.length; i += 65515) parts.push(pkt(Buffer.concat([Buffer.from([band]), data.subarray(i, i + 65515)])));
  return Buffer.concat(parts);
}
function readPktStream(buf: Buffer): (string | null)[] {
  const out: (string | null)[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString(), 16);
    i += 4;
    if (!Number.isFinite(len)) break;
    if (len === 0) { out.push(null); continue; }
    if (len < 4) { out.push(`#${len}`); continue; }
    out.push(buf.subarray(i, i + len - 4).toString());
    i += len - 4;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > 300 * 1024 * 1024) reject(new Error('too large')); chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function refList(repo: S.Repo): [string, string][] {
  const rows: [string, string][] = [];
  const head = repo.refs.get('HEAD') ?? repo.refs.get(`refs/heads/${repo.default_branch}`);
  if (head) rows.push(['HEAD', head]);
  for (const [ref, sha] of repo.refs) if (ref.startsWith('refs/')) rows.push([ref, sha]);
  return rows;
}

export async function infoRefs(req: IncomingMessage, res: ServerResponse, repo: S.Repo | undefined, service: 'upload' | 'receive'): Promise<void> {
  if (!repo) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found\n'); return; }
  res.writeHead(200, { 'content-type': `application/x-git-${service}-pack-advertisement`, 'cache-control': 'no-cache' });
  const v2 = service === 'upload' && /version=2/.test(String(req.headers['git-protocol'] ?? ''));
  res.write(pkt(`# service=git-${service}-pack\n`)); res.write(FLUSH);
  if (v2) { for (const line of CAPS_V2) res.write(pkt(`${line}\n`)); res.write(FLUSH); res.end(); return; }
  const caps = service === 'upload'
    ? 'side-band-64k thin-pack ofs-delta shallow no-progress include-tag agent=makefun-forge/1.0'
    : 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0';
  const rows = refList(repo);
  if (!rows.length) { res.write(pkt(`${ZERO} capabilities^{}\0${caps}\n`)); res.write(FLUSH); res.end(); return; }
  const out: Buffer[] = [];
  rows.forEach(([ref, sha], idx) => {
    const tail = idx === 0 ? `\0${caps}` : '';
    out.push(pkt(`${sha} ${ref}${tail}\n`));
    if (repo.objects.get(sha)?.type === 'tag') out.push(pkt(`${tagTarget(repo, sha)} ${ref}^{}\n`));
  });
  out.push(FLUSH);
  res.end(Buffer.concat(out));
}

export async function uploadPack(req: IncomingMessage, res: ServerResponse, repo: S.Repo | undefined): Promise<void> {
  if (!repo) { res.writeHead(404); res.end(); return; }
  const body = await readBody(req);
  const lines = readPktStream(body).filter((l): l is string => l !== null).map((l) => l.replace(/\r?\n$/, ''));
  const cmd = lines[0] ?? '';
  const v2 = /^command=/.test(cmd);
  if (v2 && cmd === 'command=ls-refs') return lsRefs(res, repo, lines);
  if (v2 && cmd === 'command=fetch') return fetchV2(res, repo, lines);
  return fetchV0(res, repo, lines);
}

function lsRefs(res: ServerResponse, repo: S.Repo, lines: string[]): void {
  const rend = REND;
  const prefixes = lines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice(11).trim());
  const symrefs = lines.includes('symrefs');
  const out: Buffer[] = [];
  const rows = refList(repo).filter(([ref]) => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p)));
  for (const [ref, sha] of rows) {
    if (ref === 'HEAD' && !prefixes.some((p) => 'HEAD'.startsWith(p)) && prefixes.length) continue;
    const attr = ref === 'HEAD' && symrefs ? ` symref-target:refs/heads/${repo.default_branch}` : '';
    const peeled = repo.objects.get(sha)?.type === 'tag' ? ` peeled:${tagTarget(repo, sha)}` : '';
    out.push(pkt(`${sha} ${ref}${attr}${peeled}\n`));
  }
  out.push(FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(out));
}

function tagTarget(repo: S.Repo, sha: string): string {
  const o = repo.objects.get(sha); if (!o) return sha;
  const m = o.body.toString().match(/^object ([0-9a-f]{40})$/m);
  return m ? m[1] : sha;
}

function collectGraph(repo: S.Repo, wants: string[], haves: string[], depth: number | null, shallow: string[], deepenSince: number | null): { objects: Set<string>; shallow: string[]; unshallow: string[] } {
  const known = new Set<string>();
  if (haves.length) {
    const stop = new Set(shallow);
    const stack = [...haves];
    while (stack.length) {
      const s2 = stack.pop() as string;
      if (known.has(s2)) continue;
      known.add(s2);
      const o2 = repo.objects.get(s2);
      if (!o2) continue;
      if (o2.type === 'commit' && !stop.has(s2)) { const i2 = S.commitInfo(repo, s2); if (i2) { stack.push(i2.tree, ...i2.parents); } }
      else if (o2.type === 'tree') for (const e2 of S.treeEntries(o2.body)) stack.push(e2.sha);
    }
  }
  const objects = new Set<string>();
  const shallowOut: string[] = [];
  const unshallow: string[] = [];
  const seen = new Set<string>();
  const q: [string, number][] = [...wants.map((w) => [w, 0] as [string, number]), ...shallow.map((w) => [w, 0] as [string, number])];
  const now = Math.floor(Date.now() / 1000);
  while (q.length) {
    const [sha, d] = q.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const o = repo.objects.get(sha); if (!o) continue;
    const heldAlready = known.has(sha);
    if (!heldAlready) objects.add(sha);
    if (o.type === 'commit') {
      const info = S.commitInfo(repo, sha); if (!info) continue;
      for (const e of S.treeEntries(S.getObj(repo, info.tree)?.body ?? Buffer.alloc(0))) q.push([e.sha, d]);
      q.push([info.tree, d]);
      const atDepth = depth !== null && d + 1 >= depth;
      const sinceDepth = deepenSince !== null && Number(info.date) < deepenSince;
      if (atDepth || (sinceDepth && shallow.length === 0)) { if (!shallowOut.includes(sha)) shallowOut.push(sha); continue; }
      if (heldAlready) { for (const p of info.parents) { if (!known.has(p) && !seen.has(p)) q.push([p, d + 1]); } continue; }
      for (const p of info.parents) { if (known.has(p)) { if (shallow.length) unshallow.push(p); continue; } q.push([p, d + 1]); }
    } else if (o.type === 'tree') {
      for (const e of S.treeEntries(o.body)) { if (!known.has(e.sha)) objects.add(e.sha); if (e.mode === '40000' && !seen.has(e.sha)) q.push([e.sha, d]); }
    } else if (o.type === 'tag') {
      const t = tagTarget(repo, sha); objects.add(t); q.push([t, d]);
    }
  }
  void now;
  return { objects, shallow: shallowOut, unshallow };
}

function objHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let n = size;
  let first = (type << 4) | (n & 15);
  n >>= 4;
  while (n > 0) { bytes.push(first | 0x80); first = n & 127; n >>= 7; }
  bytes.push(first);
  return Buffer.from(bytes);
}

const packCache = new Map<string, Buffer>();
export function cacheKey(repo: S.Repo, shas: Set<string>): string {
  return `${(repo as unknown as { id: number }).id}:${[...shas].sort().join(',')}`;
}

function packOf(repo: S.Repo, shas: Set<string>): Buffer {
  const key = cacheKey(repo, shas);
  const hit = packCache.get(key);
  if (hit) return hit;
  const built = buildPack(repo, shas);
  if (packCache.size > 200) packCache.clear();
  packCache.set(key, built);
  return built;
}

function buildPack(repo: S.Repo, shas: Set<string>): Buffer {
  const parts: Buffer[] = [Buffer.from(`PACK${'\x00\x00\x00\x02'}`), Buffer.alloc(4)];
  parts[1].writeUInt32BE(shas.size, 0);
  for (const sha of shas) {
    const o = repo.objects.get(sha); if (!o) continue;
    const typeNum = o.type === 'commit' ? 1 : o.type === 'tree' ? 2 : o.type === 'blob' ? 3 : 4;
    parts.push(objHeader(typeNum, o.body.length), deflateSync(o.body));
  }
  const pack = Buffer.concat(parts);
  const sum = S.sha1(pack);
  return Buffer.concat([pack, Buffer.from(sum, 'hex')]);
}

function fetchSections(res: ServerResponse, sections: { acks?: string; shallow?: string; wanted?: Buffer; pack?: Buffer }, band: boolean): void {
  const out: Buffer[] = [];
  if (sections.acks) { out.push(pkt('acknowledgments\n'), pkt(sections.acks)); out.push(FLUSH); }
  if (sections.shallow) { out.push(pkt('shallow-info\n'), pkt(sections.shallow), FLUSH); }
  if (sections.pack) {
    out.push(pkt('packfile\n'));
    if (band) out.push(sideband(1, sections.pack));
    else out.push(sections.pack);
  }
  const mode = process.env.TAIL ?? 'f';
  if (mode === 'a7') out.push(pkt(Buffer.from([1, 0xa7])), FLUSH);
  else if (mode === 'z') out.push(pkt(Buffer.from([1, 0x30, 0x30, 0x30, 0x30])), FLUSH);
  else if (mode === 'b') out.push(pkt(Buffer.from([1])), FLUSH);
  else if (mode === 'f') out.push(FLUSH);
  else if (mode === 'rend') out.push(REND);
  const payload = Buffer.concat(out);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': String(payload.length) });
  res.end(payload);
}

function fetchV2(res: ServerResponse, repo: S.Repo, lines: string[]): void {
  const done = lines.includes('done');
  const wants = lines.filter((l) => l.startsWith('want ')).map((l) => l.slice(5).trim()).filter(Boolean);
  const haves = lines.filter((l) => l.startsWith('have ')).map((l) => l.slice(5).trim());
  const shallow = lines.filter((l) => l.startsWith('shallow ')).map((l) => l.slice(8).trim());
  const depthLine = lines.find((l) => l.startsWith('deepen '));
  const sinceLine = lines.find((l) => l.startsWith('deepen-since '));
  const band = true;
  const depth = depthLine ? Number(depthLine.slice(7)) : null;
  const since = sinceLine ? Number(sinceLine.slice(13)) : null;
  const { objects, shallow: shallowOut, unshallow } = collectGraph(repo, wants, haves, depth, shallow, since);
  const shallowLines = [...shallowOut.map((s) => `shallow ${s}\n`), ...unshallow.map((s) => `unshallow ${s}\n`)].join('');
  if (objects.size === 0 && haves.length && !done) return fetchSections(res, { acks: `ACK ${haves[haves.length - 1]}\n`, shallow: shallowLines || undefined }, band);
  fetchSections(res, {
    acks: done ? undefined : haves.length ? `ACK ${haves[haves.length - 1]}\n` : 'NAK\n',
    shallow: shallowLines || undefined,
    pack: packOf(repo, objects),
  }, band);
}

function fetchV0(res: ServerResponse, repo: S.Repo, lines: string[]): void {
  const wants = lines.filter((l) => l.startsWith('want ')).map((l) => l.slice(5, 45));
  const haves = lines.filter((l) => l.startsWith('have ')).map((l) => l.slice(5, 45));
  const shallow = lines.filter((l) => l.startsWith('shallow ')).map((l) => l.slice(8, 48));
  const depthLine = lines.find((l) => l.startsWith('deepen '));
  const depth = depthLine ? Number(depthLine.slice(7)) : null;
  const { objects, shallow: shallowOut, unshallow } = collectGraph(repo, wants, haves, depth, shallow, null);
  const out: Buffer[] = [];
  const band = lines.some((l) => l.startsWith('side-band') || l.includes('side-band'));
  for (const s of shallowOut) out.push(pkt(`shallow ${s}\n`));
  for (const s of unshallow) out.push(pkt(`unshallow ${s}\n`));
  out.push(FLUSH);
  if (haves.length) out.push(pkt(`ACK ${haves[haves.length - 1]} continue\n`));
  out.push(pkt('NAK\n'));
  const pack = packOf(repo, objects);
  if (band) out.push(sideband(1, pack), pkt(''), FLUSH); else out.push(pack);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(out));
}

// ---------------------------------------------------------------- receive-pack
export async function receivePack(req: IncomingMessage, res: ServerResponse, repo: S.Repo | undefined): Promise<void> {
  if (!repo) { res.writeHead(404); res.end(); return; }
  const body = await readBody(req);
  if (process.env.DUMP) (await import('node:fs')).writeFileSync(process.env.DUMP, body);
  const lines: (string | null)[] = [];
  let i = 0;
  while (i + 4 <= body.length) {
    const len = parseInt(body.subarray(i, i + 4).toString(), 16);
    if (!Number.isFinite(len) || len === 0) { i += 4; lines.push(null); if (len === 0) break; continue; }
    const text = body.subarray(i + 4, i + len).toString();
    lines.push(text); i += len;
  }
  const packBuf = body.subarray(i);
  const commands: { old: string; new: string; ref: string }[] = [];
  let caps = '';
  for (const l of lines) {
    if (!l) break;
    const m = l.trim().split(' ');
    if (m.length < 3) continue;
    const [old, nw] = m;
    const refPart = m.slice(2).join(' ');
    const [ref, ...capParts] = refPart.split('\0');
    if (capParts.length) caps = capParts.join(' ');
    commands.push({ old, new: nw, ref });
  }
  if (packBuf.length > 8) ingest(repo, packBuf);
  const report: string[] = [];
  for (const c of commands) {
    if (c.new === ZERO) {
      if (repo.refs.has(c.ref)) { repo.refs.delete(c.ref); if (c.ref === 'refs/heads/main') repo.refs.delete('HEAD'); report.push(`ok ${c.ref}\n`); }
      else report.push(`ng ${c.ref} no such ref\n`);
      continue;
    }
    const cur = repo.refs.get(c.ref) ?? (c.ref.startsWith('refs/heads/') ? repo.refs.get('HEAD') : undefined);
    const creating = c.old === ZERO || cur === undefined;
    const ff = creating || S.isAncestor(repo, c.old, c.new);
    if (!ff) { report.push(`ng ${c.ref} non-fast-forward\n`); continue; }
    repo.refs.set(c.ref, c.new);
    if (c.ref.startsWith('refs/heads/') && !repo.refs.has('HEAD')) repo.refs.set('HEAD', c.new);
    report.push(`ok ${c.ref}\n`);
  }
  const text = report.join('');
  if (process.env.TRACE) process.stderr.write(`recv cmds=${JSON.stringify(commands)} report=${JSON.stringify(text)}\n`);
  const band = /side-band-64k/.test(caps);
  const out = band
    ? [sideband(1, Buffer.concat([pkt('unpack ok\n'), ...report.map((r) => pkt(r)), FLUSH])), FLUSH]
    : [pkt('unpack ok\n'), ...report.map((r) => pkt(r)), FLUSH];
  const payload = Buffer.concat(out);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': String(payload.length) });
  res.end(payload);
}

export { ingestPack, deltaApply } from './pack.ts';

export { readPktStream };
