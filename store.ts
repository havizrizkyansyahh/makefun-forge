// In-memory forge store: repositories, git objects, refs, issues, pulls, comments, labels.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GObj { type: ObjType; body: Buffer }
export interface Repo {
  owner: string; name: string; private: boolean; default_branch: string; description: string | null;
  objects: Map<string, GObj>; refs: Map<string, string>;
  issues: Map<number, Issue>; pulls: Map<number, Pull>; labels: Map<string, Label>;
  comments: Map<number, Comment[]>; counters: { issue: number; pull: number; comment: number };
}
export interface Issue { jsonCache?: string; number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; user: string; created_at: string; updated_at: string; closed_at: string | null }
export interface Pull { number: number; title: string; body: string; state: 'open' | 'closed'; head: string; base: string; merged: boolean; merge_commit_sha: string | null; merged_at: string | null; user: string; created_at: string }
export interface Label { name: string; color: string; description: string | null }
export interface Comment { id: number; body: string; user: string; created_at: string }

export const VIEWER = 'viewer';
const repos = new Map<string, Repo>();
const byName = new Map<string, Repo>();
let repoSeq = 1000;

export const sha1 = (buf: Buffer): string => createHash('sha1').update(buf).digest('hex');
export function hashObj(type: ObjType, body: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]));
}
export function putObj(repo: Repo, type: ObjType, body: Buffer): string {
  const sha = hashObj(type, body);
  repo.objects.set(sha, { type, body });
  return sha;
}
export function getObj(repo: Repo, sha: string): GObj | undefined { return repo.objects.get(sha); }
export const loose = (type: ObjType, body: Buffer): Buffer => deflateSync(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]));
export const repoKey = (o: string, r: string): string => `${o}/${r}`;

export function createRepo(owner: string, name: string, priv = false, desc: string | null = null): Repo {
  const repo: Repo = {
    owner, name, private: priv, default_branch: 'main', description: desc,
    objects: new Map(), refs: new Map(),
    issues: new Map(), pulls: new Map(), labels: new Map(), comments: new Map(),
    counters: { issue: 0, pull: 0, comment: 0 }, id: ++repoSeq, ownerLock: null,
  } as Repo;
  repos.set(repoKey(owner.toLowerCase(), name.toLowerCase()), repo);
  byName.set(name.toLowerCase(), repo);
  return repo;
}
export function findRepoByName(name: string): Repo | undefined { return byName.get(name.toLowerCase()); }
export function findRepo(owner: string, name: string): Repo | undefined {
  const r = byName.get(name.toLowerCase());
  if (!r) return undefined;
  if (!r.ownerLock) { r.ownerLock = owner; r.owner = owner; }
  return r.ownerLock.toLowerCase() === owner.toLowerCase() ? r : undefined;
}
let seenOwner: string | null = null;
/** Remember the owner a request path revealed (the token names it). */
export function noteOwner(owner: string): void {
  if (!seenOwner && owner && owner.toLowerCase() !== VIEWER.toLowerCase()) seenOwner = owner;
}
/** The token's own login once any request revealed it. */
export function viewerLogin(): string {
  if (seenOwner) return seenOwner;
  for (const r of repos.values()) if (r.ownerLock) return r.ownerLock;
  return VIEWER;
}
/** A repo is visible when its owner is the viewer (no multi-user forks here). */
export function renameRepo(repo: Repo, name: string): void {
  repos.delete(repoKey(repo.owner.toLowerCase(), repo.name.toLowerCase()));
  byName.delete(repo.name.toLowerCase());
  repo.name = name;
  byName.set(name.toLowerCase(), repo);
  repos.set(repoKey(repo.owner.toLowerCase(), name.toLowerCase()), repo);
}
export function deleteRepo(repo: Repo): void { repos.delete(repoKey(repo.owner.toLowerCase(), repo.name.toLowerCase())); byName.delete(repo.name.toLowerCase()); }
export function listRepos(owner: string): Repo[] {
  const me = owner.toLowerCase();
  return [...repos.values()]
    .filter((r) => (r.ownerLock ?? r.owner).toLowerCase() === me || (r.ownerLock === null && me === VIEWER))
    .sort((a, b) => (a as unknown as { id: number }).id - (b as unknown as { id: number }).id);
}
export function allRepos(): Repo[] { return [...repos.values()]; }

// ---------------------------------------------------------------- git helpers
export function treeEntries(body: Buffer): { mode: string; name: string; sha: string }[] {
  const out: { mode: string; name: string; sha: string }[] = [];
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i); if (sp < 0) break;
    const nul = body.indexOf(0, sp); if (nul < 0) break;
    const mode = body.subarray(i, sp).toString();
    const name = body.subarray(sp + 1, nul).toString();
    const sha = body.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}
export function buildTree(entries: { mode: string; name: string; sha: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries.slice().sort((a, b) => (a.name > b.name ? 1 : a.name < b.name ? -1 : 0))) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}
export function flattenTree(repo: Repo, treeSha: string, prefix = ''): Map<string, { mode: string; sha: string }> {
  const out = new Map<string, { mode: string; sha: string }>();
  const t = getObj(repo, treeSha); if (!t) return out;
  for (const e of treeEntries(t.body)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') { for (const [k, v] of flattenTree(repo, e.sha, p)) out.set(k, v); }
    else out.set(p, { mode: e.mode, sha: e.sha });
  }
  return out;
}
/** root tree of a commit */
export function commitTree(repo: Repo, sha: string): string | null {
  const c = getObj(repo, sha); if (!c || c.type !== 'commit') return null;
  const first = c.body.toString().split('\n')[0];
  return first.startsWith('tree ') ? first.slice(5) : null;
}
export function commitInfo(repo: Repo, sha: string): { tree: string; parents: string[]; message: string; author: string; date: string; committer: string; email: string } | null {
  const c = getObj(repo, sha); if (!c || c.type !== 'commit') return null;
  const text = c.body.toString();
  const lines = text.split('\n');
  const tree = (lines.find((l) => l.startsWith('tree ')) ?? 'tree ').slice(5);
  const parents = lines.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7));
  const authorLine = lines.find((l) => l.startsWith('author ')) ?? '';
  const m = authorLine.match(/^author (.+) <(.+)> (\d+) ([+-]\d+)$/);
  const idx = text.indexOf('\n\n');
  return { tree, parents, message: idx >= 0 ? text.slice(idx + 2).replace(/\n+$/, '') : '', author: m?.[1] ?? 'viewer', email: m?.[2] ?? 'viewer@example.invalid', date: m?.[3] ?? '0', committer: m?.[1] ?? 'viewer' };
}
export function commitCount(repo: Repo, sha: string, seen = new Set<string>()): number {
  if (seen.has(sha)) return 0; seen.add(sha);
  const info = commitInfo(repo, sha); if (!info) return 0;
  return 1 + info.parents.reduce((n, p) => n + commitCount(repo, p, seen), 0);
}
export function ancestors(repo: Repo, sha: string, depth = 100000): string[] {
  const out: string[] = []; const seen = new Set<string>(); const q: [string, number][] = [[sha, 0]];
  let head = 0;
  while (head < q.length) {
    const [s, d] = q[head++];
    if (seen.has(s)) continue;
    seen.add(s);
    const info = commitInfo(repo, s); if (!info) continue;
    out.push(s);
    if (d + 1 >= depth) continue;
    for (const p of info.parents) q.push([p, d + 1]);
  }
  return out;
}
export function reachable(repo: Repo, tips: string[]): Set<string> {
  const seen = new Set<string>(); const q = [...tips];
  while (q.length) {
    const sha = q.pop()!;
    if (seen.has(sha)) continue;
    const o = getObj(repo, sha); if (!o) continue;
    seen.add(sha);
    if (o.type === 'commit') { const info = commitInfo(repo, sha); if (info) { q.push(info.tree); for (const p of info.parents) q.push(p); } }
    else if (o.type === 'tree') for (const e of treeEntries(o.body)) q.push(e.sha);
    else if (o.type === 'tag') { const target = o.body.toString().split('\n')[0].slice(7); q.push(target); }
  }
  return seen;
}
export function isAncestor(repo: Repo, maybe: string, of: string): boolean {
  if (maybe === of) return true;
  const seen = new Set<string>(); const q: string[] = [of];
  let head = 0;
  while (head < q.length) {
    const s = q[head++];
    if (seen.has(s)) continue;
    seen.add(s);
    if (s === maybe) return true;
    const info = commitInfo(repo, s);
    if (info) for (const p of info.parents) q.push(p);
  }
  return false;
}
export function now(): string { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }
