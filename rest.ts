// GitHub REST v3 surface.
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as S from './store.ts';

export const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...extra });
  res.end(text, 'utf8');
};
export const err = (res: ServerResponse, status: number, message: string): void => json(res, status, { message });

export function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

export function repoJson(repo: S.Repo, base: string): Record<string, unknown> {
  return {
    id: (repo as unknown as { id: number }).id, node_id: Buffer.from(`R_${(repo as unknown as { id: number }).id}`).toString('base64'),
    name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private,
    owner: { login: S.viewerLogin(), id: 1, type: 'User', site_admin: false },
    html_url: `${base}/${repo.owner}/${repo.name}`, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    description: repo.description, default_branch: repo.default_branch, fork: false,
    created_at: S.now(), updated_at: S.now(), pushed_at: null, size: 0, stargazers_count: 0,
    watchers_count: 0, forks_count: 0, open_issues_count: repo.issues.size, has_issues: true,
    permissions: { admin: true, push: true, pull: true }, visibility: repo.private ? 'private' : 'public',
  };
}

function issueJson(repo: S.Repo, i: S.Issue, base: string): Record<string, unknown> {
  return {
    id: i.number * 1000, node_id: Buffer.from(`I_${i.number}`).toString('base64'), number: i.number, title: i.title, body: i.body,
    state: i.state, user: { login: i.user }, labels: i.labels.map((n) => ({ name: n })),
    created_at: i.created_at, updated_at: i.updated_at, closed_at: i.closed_at,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${i.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${i.number}`,
    comments: (repo.comments.get(i.number) ?? []).length,
  };
}

function pullJson(repo: S.Repo, p: S.Pull, base: string): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${p.head}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${p.base}`) ?? '';
  return {
    id: p.number * 1000, node_id: Buffer.from(`P_${p.number}`).toString('base64'), number: p.number, title: p.title, body: p.body,
    state: p.state, merged: p.merged, merged_at: p.merged_at, merge_commit_sha: p.merge_commit_sha,
    head: { ref: p.head, sha: headSha, label: `${repo.owner}:${p.head}` },
    base: { ref: p.base, sha: baseSha, label: `${repo.owner}:${p.base}` },
    user: { login: p.user }, created_at: p.created_at, updated_at: p.created_at,
    mergeable: true, draft: false,
  };
}

export function diffTrees(repo: S.Repo, baseTree: string | null, headTree: string | null): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const a = baseTree ? S.flattenTree(repo, baseTree) : new Map<string, { mode: string; sha: string }>();
  const b = headTree ? S.flattenTree(repo, headTree) : new Map<string, { mode: string; sha: string }>();
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  for (const [p, e] of b) {
    const old = a.get(p);
    if (!old) { out.push({ filename: p, status: 'added', additions: lines(repo, e.sha), deletions: 0, changes: lines(repo, e.sha) }); }
    else if (old.sha !== e.sha) { const ad = lines(repo, e.sha), de = lines(repo, old.sha); out.push({ filename: p, status: 'modified', additions: ad, deletions: de, changes: ad + de }); }
  }
  for (const [p, e] of a) if (!b.has(p)) out.push({ filename: p, status: 'removed', additions: 0, deletions: lines(repo, e.sha), changes: lines(repo, e.sha) });
  return out.sort((x, y) => (x.filename > y.filename ? 1 : -1));
}
const lines = (repo: S.Repo, sha: string): number => (S.getObj(repo, sha)?.body.toString().split('\n').length ?? 0);

function mergeBase(repo: S.Repo, a: string, b: string): string | null {
  const anc = new Set(S.ancestors(repo, a));
  const q = [b];
  while (q.length) { const s = q.shift()!; if (anc.has(s)) return s; const info = S.commitInfo(repo, s); if (info) q.push(...info.parents); }
  return null;
}

interface Ctx { req: IncomingMessage; res: ServerResponse; body: Buffer; base: string; url: URL | null }

const P = (s: string): string => decodeURIComponent(s);

export async function handle(ctx: Ctx, method: string, path: string): Promise<boolean> {
  const { res, base } = ctx;
  let m: RegExpMatchArray | null;
  if (method === 'GET' && (path === '/api/v3/' || path === '/api/v3')) { json(res, 200, { current_user_url: `${base}/api/v3/user` }, { 'x-oauth-scopes': 'repo, read:org' }); return true; }
  if (method === 'GET' && path === '/api/v3/meta') { json(res, 200, { installed_version: '3.0.0-makefun' }); return true; }
  if (method === 'GET' && path === '/api/v3/user') { json(res, 200, { login: S.viewerLogin(), id: 1, type: 'User' }); return true; }

  if (method === 'GET' && path === '/api/v3/user/repos') {
    const url = ctx.url ?? new URL(ctx.req.url ?? '/', 'http://x');
    const per = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? 30)));
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const all = S.listRepos(S.viewerLogin());
    const slice = all.slice((page - 1) * per, page * per);
    const headers: Record<string, string> = {};
    if (page * per < all.length) {
      const u = new URL(`${base}/api/v3/user/repos`);
      u.searchParams.set('per_page', String(per)); u.searchParams.set('page', String(page + 1));
      headers.link = `<${u.toString()}>; rel="next", <${u.toString()}>; rel="last"`;
    }
    json(res, 200, slice.map((r) => repoJson(r, base)), headers);
    return true;
  }
  if (method === 'POST' && path === '/api/v3/user/repos') {
    const b = ctx.body.length ? JSON.parse(ctx.body.toString()) : {};
    if (!b.name || typeof b.name !== 'string') { err(res, 422, 'name is required'); return true; }
    if (S.findRepoByName(b.name)) { err(res, 422, 'name already exists on this account'); return true; }
    const repo = S.createRepo(S.VIEWER, b.name, Boolean(b.private), b.description ?? null);
    if (b.auto_init) {
      const blob = S.putObj(repo, 'blob', Buffer.from(b.readme ?? ''));
      const tree = S.putObj(repo, 'tree', S.buildTree([{ mode: '100644', name: 'README.md', sha: blob }]));
      const commit = S.putObj(repo, 'commit', Buffer.from(`tree ${tree}\nauthor viewer <viewer@example.invalid> ${Math.floor(Date.now() / 1000)} +0000\ncommitter viewer <viewer@example.invalid> ${Math.floor(Date.now() / 1000)} +0000\n\ninitial commit\n`));
      repo.refs.set(`refs/heads/${repo.default_branch}`, commit); repo.refs.set('HEAD', commit);
    }
    json(res, 201, repoJson(repo, base));
    return true;
  }

  if ((m = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/)) && ctx.req.method === method) {
    const repo = S.findRepo(P(m[1]), P(m[2]));
    if (!repo) { err(res, 404, 'Not Found'); return true; }
    if (method === 'GET') { json(res, 200, repoJson(repo, base)); return true; }
    if (method === 'PATCH') {
      const b = ctx.body.length ? JSON.parse(ctx.body.toString()) : {};
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.private === 'boolean') repo.private = b.private;
      if (typeof b.name === 'string' && b.name !== repo.name) S.renameRepo(repo, b.name);
      json(res, 200, repoJson(repo, base)); return true;
    }
    if (method === 'DELETE') { S.deleteRepo(repo); res.writeHead(204); res.end(); return true; }
  }

  if ((m = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches$/))) {
    const repo = S.findRepo(P(m[1]), P(m[2])); if (!repo) { err(res, 404, 'Not Found'); return true; }
    json(res, 200, [...repo.refs].filter(([r]) => r.startsWith('refs/heads/')).map(([r, sha]) => ({ name: r.slice(11), commit: { sha } })));
    return true;
  }
  if ((m = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/commits$/))) {
    const repo = S.findRepo(P(m[1]), P(m[2])); if (!repo) { err(res, 404, 'Not Found'); return true; }
    const url = ctx.url ?? new URL(ctx.req.url ?? '/', 'http://x');
    const want = url.searchParams.get('sha');
    const ref = (want ? repo.refs.get(`refs/heads/${want}`) ?? repo.refs.get(`refs/tags/${want}`) ?? want : repo.refs.get(`refs/heads/${repo.default_branch}`)) ?? '';
    const shas = ref ? S.ancestors(repo, ref) : [];
    const out = shas.slice(0, 100).map((sha) => { const info = S.commitInfo(repo, sha); return { sha, commit: { message: info?.message ?? '', author: { name: info?.author, date: info?.date } } }; });
    json(res, 200, out); return true;
  }
  if ((m = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/))) {
    const repo = S.findRepo(P(m[1]), P(m[2])); if (!repo) { err(res, 404, 'Not Found'); return true; }
    const b = ctx.body.length ? JSON.parse(ctx.body.toString()) : {};
    let ref = String(b.ref ?? '');
    if (ref && !ref.startsWith('refs/')) ref = `refs/heads/${ref}`;
    const sha = String(b.sha ?? '');
    if (!ref || !S.getObj(repo, sha)) { err(res, 422, 'ref and sha are required'); return true; }
    repo.refs.set(ref, sha);
    json(res, 201, { ref, object: { sha, type: 'commit', url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` } });
    return true;
  }
  if ((m = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs\/(.+)$/))) {
    const repo = S.findRepo(P(m[1]), P(m[2])); if (!repo) { err(res, 404, 'Not Found'); return true; }
    if (method === 'DELETE') { repo.refs.delete(`refs/heads/${P(m[3])}`); res.writeHead(204); res.end(); return true; }
  }

  if ((m = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents(\/.*)?$/))) {
    const repo = S.findRepo(P(m[1]), P(m[2])); if (!repo) { err(res, 404, 'Not Found'); return true; }
    return await contents(ctx, method, repo, m[3] ? P(m[3].slice(1)) : '');
  }

  if ((m = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/))) {
    const repo = S.findRepo(P(m[1]), P(m[2])); if (!repo) { err(res, 404, 'Not Found'); return true; }
    const b = ctx.body.length ? JSON.parse(ctx.body.toString()) : {};
    if (!b.name) { err(res, 422, 'name is required'); return true; }
    repo.labels.set(b.name, { name: b.name, color: b.color ?? 'ededed', description: b.description ?? null });
    json(res, 201, { name: b.name, color: b.color ?? 'ededed', description: b.description ?? null });
    return true;
  }

  if ((m = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/))) {
    const repo = S.findRepo(P(m[1]), P(m[2])); if (!repo) { err(res, 404, 'Not Found'); return true; }
    return await issues(ctx, method, repo);
  }
  if ((m = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/))) {
    const repo = S.findRepo(P(m[1]), P(m[2])); if (!repo) { err(res, 404, 'Not Found'); return true; }
    return await issues(ctx, method, repo, Number(m[3]));
  }
  if ((m = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/))) {
    const repo = S.findRepo(P(m[1]), P(m[2])); if (!repo) { err(res, 404, 'Not Found'); return true; }
    const issue = repo.issues.get(Number(m[3])); if (!issue) { err(res, 404, 'Not Found'); return true; }
    if (method === 'POST') {
      const b = ctx.body.length ? JSON.parse(ctx.body.toString()) : {};
      const id = ++repo.counters.comment;
      const c: S.Comment = { id, body: String(b.body ?? ''), user: S.VIEWER, created_at: S.now() };
      repo.comments.set(issue.number, [...(repo.comments.get(issue.number) ?? []), c]);
      issue.jsonCache = undefined;
      json(res, 201, c); return true;
    }
    json(res, 200, repo.comments.get(issue.number) ?? []); return true;
  }

  if ((m = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/))) {
    const repo = S.findRepo(P(m[1]), P(m[2])); if (!repo) { err(res, 404, 'Not Found'); return true; }
    if (method === 'GET') {
      const url = ctx.url ?? new URL(ctx.req.url ?? '/', 'http://x');
      const state = url.searchParams.get('state') ?? 'open';
      const all = [...repo.pulls.values()].filter((p) => state === 'all' || (state === 'closed' ? p.state === 'closed' : p.state === 'open'));
      json(res, 200, all.map((p) => pullJson(repo, p, base))); return true;
    }
    const b = ctx.body.length ? JSON.parse(ctx.body.toString()) : {};
    const head = String(b.head ?? ''); const baseRef = String(b.base ?? repo.default_branch);
    if (!repo.refs.get(`refs/heads/${head}`)) { err(res, 422, 'head branch is unknown'); return true; }
    if (!repo.refs.get(`refs/heads/${baseRef}`)) { err(res, 422, 'base branch is unknown'); return true; }
    const number = ++repo.counters.pull;
    const pull: S.Pull = { number, title: String(b.title ?? ''), body: String(b.body ?? ''), state: 'open', head, base: baseRef, merged: false, merge_commit_sha: null, merged_at: null, user: S.VIEWER, created_at: S.now() };
    repo.pulls.set(number, pull);
    json(res, 201, pullJson(repo, pull, base)); return true;
  }
  if ((m = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/))) {
    const repo = S.findRepo(P(m[1]), P(m[2])); if (!repo) { err(res, 404, 'Not Found'); return true; }
    const pull = repo.pulls.get(Number(m[3])); if (!pull) { err(res, 404, 'Not Found'); return true; }
    if (method === 'PATCH') {
      const b = ctx.body.length ? JSON.parse(ctx.body.toString()) : {};
      if (typeof b.title === 'string') pull.title = b.title;
      if (typeof b.body === 'string') pull.body = b.body;
      if (b.state === 'closed') { pull.state = 'closed'; }
      json(res, 200, pullJson(repo, pull, base)); return true;
    }
    json(res, 200, pullJson(repo, pull, base)); return true;
  }
  if ((m = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/))) {
    const repo = S.findRepo(P(m[1]), P(m[2])); if (!repo) { err(res, 404, 'Not Found'); return true; }
    const pull = repo.pulls.get(Number(m[3])); if (!pull) { err(res, 404, 'Not Found'); return true; }
    const headSha = repo.refs.get(`refs/heads/${pull.head}`); const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
    const mt = headSha && baseSha ? mergeBase(repo, baseSha, headSha) : null;
    const baseTree = mt ? S.commitInfo(repo, mt)?.tree ?? null : null;
    json(res, 200, diffTrees(repo, baseTree, headSha ? S.commitInfo(repo, headSha)?.tree ?? null : null).map((f) => ({ ...f, additions: f.additions, deletions: f.deletions, changes: f.changes, status: f.status })));
    return true;
  }
  if ((m = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/))) {
    const repo = S.findRepo(P(m[1]), P(m[2])); if (!repo) { err(res, 404, 'Not Found'); return true; }
    const pull = repo.pulls.get(Number(m[3])); if (!pull) { err(res, 404, 'Pull request not found'); return true; }
    const headSha = repo.refs.get(`refs/heads/${pull.head}`); const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
    if (!headSha || !baseSha) { err(res, 405, 'pull request is not mergeable'); return true; }
    if (!S.isAncestor(repo, baseSha, headSha)) { err(res, 405, 'merge conflict'); return true; }
    const b = ctx.body.length ? JSON.parse(ctx.body.toString()) : {};
    const info = S.commitInfo(repo, headSha);
    const parents = [baseSha, headSha];
    const author = `viewer <viewer@example.invalid> ${Math.floor(Date.now() / 1000)} +0000`;
    const message = String(b.commit_message ?? `Merge pull request #${pull.number} from ${pull.head}`);
    const body = `tree ${info?.tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${author}\ncommitter ${author}\n\n${message}\n`;
    const commit = S.putObj(repo, 'commit', Buffer.from(body));
    repo.refs.set(`refs/heads/${pull.base}`, commit);
    if (pull.base === repo.default_branch) repo.refs.set('HEAD', commit);
    pull.state = 'closed'; pull.merged = true; pull.merged_at = S.now(); pull.merge_commit_sha = commit;
    json(res, 200, { sha: commit, merged: true, message: 'Pull Request successfully merged' });
    return true;
  }
  return false;
}

async function contents(ctx: Ctx, method: string, repo: S.Repo, path: string): Promise<boolean> {
  const { res } = ctx;
  const q = (ctx.url ?? new URL(ctx.req.url ?? '/', 'http://x')).searchParams;
  let bodyBranch: string | null = null;
  if (ctx.body.length && method !== 'GET') {
    try { const parsed = JSON.parse(ctx.body.toString()); if (typeof parsed.branch === 'string') bodyBranch = parsed.branch; } catch { /* ignore */ }
  }
  const ref = bodyBranch ?? q.get('ref') ?? q.get('branch') ?? repo.default_branch;
  const tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  const info = tip ? S.commitInfo(repo, tip) : null;
  const flat = info ? S.flattenTree(repo, info.tree) : new Map<string, { mode: string; sha: string }>();
  if (method === 'GET') {
    const e = flat.get(path);
    if (e) {
      const o = S.getObj(repo, e.sha);
      if (o?.type !== 'blob') { err(res, 404, 'Not Found'); return true; }
      json(res, 200, { name: path.split('/').pop(), path, sha: e.sha, size: o.body.length, type: 'file', encoding: 'base64', content: o.body.toString('base64') });
      return true;
    }
    const prefix = path ? `${path}/` : '';
    const dir = [...flat.entries()].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
    if (dir.length) {
      json(res, 200, dir.map(([p, v]) => ({ name: p.split('/').pop(), path: p, sha: v.sha, size: S.getObj(repo, v.sha)?.body.length ?? 0, type: 'file' })));
      return true;
    }
    err(res, 404, 'Not Found'); return true;
  }
  if (method === 'PUT') {
    const b = ctx.body.length ? JSON.parse(ctx.body.toString()) : {};
    if (typeof b.content !== 'string') { err(res, 422, 'content is required'); return true; }
    const existing = flat.get(path);
    if (b.sha && existing && b.sha !== existing.sha) { err(res, 409, 'sha does not match'); return true; }
    if (b.sha && !existing) { err(res, 422, 'sha does not match'); return true; }
    if (!b.sha && existing) { err(res, 422, 'sha is required to update'); return true; }
    const content = b.encoding === 'utf8' ? Buffer.from(String(b.content), 'utf8') : Buffer.from(String(b.content), 'base64');
    const blob = S.putObj(repo, 'blob', content);
    const updated = new Map(flat); updated.set(path, { mode: '100644', sha: blob });
    const tree = buildNested(repo, updated);
    const author = `viewer <viewer@example.invalid> ${Math.floor(Date.now() / 1000)} +0000`;
    const body = `tree ${tree}\n${info ? `parent ${tip}\n` : ''}author ${author}\ncommitter ${author}\n\n${String(b.message ?? `Update ${path}`).replace(/\n+$/, '')}\n`;
    const commit = S.putObj(repo, 'commit', Buffer.from(body));
    repo.refs.set(`refs/heads/${ref}`, commit);
    if (ref === repo.default_branch) repo.refs.set('HEAD', commit);
    json(res, existing ? 200 : 201, { content: { name: path.split('/').pop(), path, sha: blob, size: content.length, encoding: 'base64', content: content.toString('base64') }, commit: { sha: commit, message: String(b.message ?? '') } });
    return true;
  }
  if (method === 'DELETE') {
    const b = ctx.body.length ? JSON.parse(ctx.body.toString()) : {};
    const existing = flat.get(path);
    if (!existing) { err(res, 404, 'Not Found'); return true; }
    if (b.sha && b.sha !== existing.sha) { err(res, 409, 'sha does not match'); return true; }
    const updated = new Map(flat); updated.delete(path);
    const tree = buildNested(repo, updated);
    const author = `viewer <viewer@example.invalid> ${Math.floor(Date.now() / 1000)} +0000`;
    const body = `tree ${tree}\n${info ? `parent ${tip}\n` : ''}author ${author}\ncommitter ${author}\n\n${String(b.message ?? `Delete ${path}`).replace(/\n+$/, '')}\n`;
    const commit = S.putObj(repo, 'commit', Buffer.from(body));
    repo.refs.set(`refs/heads/${ref}`, commit);
    if (ref === repo.default_branch) repo.refs.set('HEAD', commit);
    json(res, 200, { commit: { sha: commit } });
    return true;
  }
  err(res, 405, 'Method Not Allowed'); return true;
}

function buildNested(repo: S.Repo, files: Map<string, { mode: string; sha: string }>): string {
  interface Node { files: Map<string, { mode: string; sha: string }>; dirs: Map<string, Node> }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [p, v] of files) {
    const parts = p.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const d = parts[i];
      if (!cur.dirs.has(d)) cur.dirs.set(d, { files: new Map(), dirs: new Map() });
      cur = cur.dirs.get(d)!;
    }
    cur.files.set(parts[parts.length - 1], v);
  }
  const emit = (n: Node): string => {
    const entries: { mode: string; name: string; sha: string }[] = [];
    for (const [name, v] of n.files) entries.push({ mode: v.mode, name, sha: v.sha });
    for (const [name, d] of n.dirs) entries.push({ mode: '40000', name, sha: emit(d) });
    return S.putObj(repo, 'tree', S.buildTree(entries));
  };
  return emit(root);
}

async function issues(ctx: Ctx, method: string, repo: S.Repo, number?: number): Promise<boolean> {
  const { res, base } = ctx;
  if (method === 'GET' && number === undefined) {
    const url = ctx.url ?? new URL(ctx.req.url ?? '/', 'http://x');
    const state = url.searchParams.get('state') ?? 'open';
    const sort = url.searchParams.get('sort');
    const dir = url.searchParams.get('direction') ?? 'desc';
    let list = [...repo.issues.values()].filter((i) => (state === 'all' ? true : state === 'closed' ? i.state === 'closed' : i.state === 'open'));
    if (sort === 'created') list = list.sort((a, b) => (a.created_at === b.created_at ? a.number - b.number : (a.created_at > b.created_at ? 1 : -1)));
    else list = list.sort((a, b) => b.number - a.number);
    if (dir === 'desc' && sort === 'created') list.reverse();
    json(res, 200, list.map((i) => issueJson(repo, i, base)));
    return true;
  }
  if (method === 'POST' && number === undefined) {
    const b = ctx.body.length ? JSON.parse(ctx.body.toString()) : {};
    const labels = Array.isArray(b.labels) ? b.labels.map((l: unknown) => (typeof l === 'string' ? l : (l as { name?: string })?.name ?? '')).filter(Boolean) : [];
    for (const l of labels) if (!repo.labels.has(l)) { err(res, 422, 'label does not exist'); return true; }
    const n = ++repo.counters.issue;
    const issue: S.Issue = { number: n, title: String(b.title ?? ''), body: String(b.body ?? ''), state: 'open', labels, user: S.VIEWER, created_at: S.now(), updated_at: S.now(), closed_at: null };
    repo.issues.set(n, issue);
    json(res, 201, issueJson(repo, issue, base)); return true;
  }
  if (number === undefined) { err(res, 405, 'Method Not Allowed'); return true; }
  const issue = repo.issues.get(number);
  if (!issue) { err(res, 404, 'Not Found'); return true; }
  if (method === 'GET') {
    if (!issue.jsonCache) issue.jsonCache = `${JSON.stringify(issueJson(repo, issue, base))}\n`;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(issue.jsonCache) });
    res.end(issue.jsonCache);
    return true;
  }
  if (method === 'PATCH') {
    const b = ctx.body.length ? JSON.parse(ctx.body.toString()) : {};
    if (typeof b.title === 'string') issue.title = b.title;
    if (typeof b.body === 'string') issue.body = b.body;
    if (b.state === 'closed') { issue.state = 'closed'; issue.closed_at = S.now(); }
    if (b.state === 'open') { issue.state = 'open'; issue.closed_at = null; }
    issue.updated_at = S.now(); issue.jsonCache = undefined;
    json(res, 200, issueJson(repo, issue, base)); return true;
  }
  err(res, 405, 'Method Not Allowed'); return true;
}
