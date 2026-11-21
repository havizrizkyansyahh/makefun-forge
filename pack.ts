// Pack ingestion: full objects plus ofs-delta/ref-delta resolution.
import * as S from './store.ts';
import { inflateSync } from 'node:zlib';

interface Rec { hdr: number; start: number; end: number; type: number; baseOff: number; baseSha: string | null; body?: Buffer }

export function ingestPack(repo: S.Repo, buf: Buffer): void {
  if (buf.subarray(0, 4).toString() !== 'PACK') return;
  const count = buf.readUInt32BE(8);
  const recs: Rec[] = [];
  let i = 12;
  let off = inflateSync; void off;
  for (let n = 0; n < count && i < buf.length - 20; n += 1) {
    const hdr = i;
    let byte = buf[i++];
    const type = (byte >> 4) & 7;
    while (byte & 0x80) byte = buf[i++];
    let baseOff = 0; let baseSha: string | null = null;
    if (type === 6) { let b = buf[i++]; baseOff = b & 127; while (b & 0x80) { b = buf[i++]; baseOff = ((baseOff + 1) << 7) | (b & 127); } }
    else if (type === 7) { baseSha = buf.subarray(i, i + 20).toString('hex'); i += 20; }
    const start = i;
    const probe = inflateSync(buf.subarray(i), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const consumed = probe.engine.bytesWritten;
    i += consumed;
    recs.push({ hdr, start, end: i, type, baseOff, baseSha, body: probe.buffer });
  }
  const byHdr = new Map<number, number>();
  recs.forEach((r, idx) => byHdr.set(r.hdr, idx));
  const shas: (string | null)[] = recs.map(() => null);
  for (let round = 0; round < 3; round += 1) {
    for (let k = 0; k < recs.length; k += 1) {
      if (shas[k]) continue;
      const r = recs[k];
      const body = r.body ?? inflateSync(buf.subarray(r.start, r.end));
      if (r.type >= 1 && r.type <= 4) {
        const t = (r.type === 1 ? 'commit' : r.type === 2 ? 'tree' : r.type === 3 ? 'blob' : 'tag') as S.ObjType;
        shas[k] = S.putObj(repo, t, body);
        continue;
      }
      let baseSha = r.baseSha;
      if (r.type === 6) { const bi = byHdr.get(r.hdr - r.baseOff); if (bi !== undefined) baseSha = shas[bi]; }
      if (!baseSha) continue;
      const baseObj = repo.objects.get(baseSha);
      if (!baseObj) continue;
      shas[k] = S.putObj(repo, baseObj.type, deltaApply(baseObj.body, body));
    }
  }
}

function consumedOf(buf: Buffer, from: number): number {
  const rest = buf.length - from;
  let lo = 2, hi = rest;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try { inflateSync(buf.subarray(from, from + mid)); hi = mid; } catch { lo = mid + 1; }
  }
  return lo;
}

export function deltaApply(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const varint = (): number => { let v = 0; let b = delta[i++]; v = b & 127; while (b & 0x80) { b = delta[i++]; v = ((v + 1) << 7) | (b & 127); } return v; };
  varint(); const target = varint();
  const out = Buffer.alloc(target);
  let o = 0;
  while (i < delta.length) {
    const cmd = delta[i++];
    if (cmd & 0x80) {
      let o2 = 0, len = 0;
      if (cmd & 1) o2 |= delta[i++];
      if (cmd & 2) o2 |= delta[i++] << 8;
      if (cmd & 4) o2 |= delta[i++] << 16;
      if (cmd & 8) o2 |= delta[i++] << 24;
      if (cmd & 16) len |= delta[i++];
      if (cmd & 32) len |= delta[i++] << 8;
      if (cmd & 64) len |= delta[i++] << 16;
      if (len === 0) len = 0x10000;
      base.copy(out, o, o2, o2 + len); o += len;
    } else if (cmd) {
      delta.copy(out, o, i, i + cmd); o += cmd; i += cmd;
    }
  }
  return out;
}
