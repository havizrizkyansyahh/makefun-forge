// Minimal GraphQL v4 subset: viewer, repository fields, issues, pulls, mutations, node(), introspection.
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as S from './store.ts';

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'closed', 'author'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: [],
};

const gid = (kind: 'I' | 'P' | 'R', n: number): string => Buffer.from(`${kind}_${n}`).toString('base64');
const unGid = (id: string): [string, number] | null => {
  const m = Buffer.from(id, 'base64').toString().match(/^([IPR])_(\d+)$/);
  return m ? [m[1], Number(m[2])] : null;
};

interface Gql { data: unknown; errors?: { message: string }[] }

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, raw: Buffer, tokenOk: boolean): Promise<void> {
  const send = (status: number, body: unknown): void => {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (!tokenOk) return send(401, { message: 'Requires authentication' });
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString()); } catch { return send(400, { message: 'Problems parsing JSON' }); }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((doc) => {
      const d = (doc ?? {}) as { query?: string; variables?: Record<string, unknown> };
      const ops = splitDocuments(String(d.query ?? ''));
      return ops.length ? runOne(ops[0], (d.variables ?? {}) as Record<string, unknown>) : { data: null };
    });
    return send(200, answers as unknown);
  }
  const payload = parsed as { query?: string; variables?: Record<string, unknown> };
  const query = String(payload.query ?? '');
  const vars = (payload.variables ?? {}) as Record<string, unknown>;
  const ops = splitDocuments(query);
  if (ops.length === 0) return send(200, { data: null, errors: [{ message: 'no operation' }] });
  const results = ops.map((doc) => runOne(doc, vars));
  if (results.length === 1) return send(200, results[0]);
  return send(200, results.map((r, i) => ({ ...(r as object), index: i })) as unknown);
}

function splitDocuments(q: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1;
  for (let i = 0; i < q.length; i += 1) {
    const c = q[i];
    if (c === '{') { if (depth === 0) start = i; depth += 1; }
    else if (c === '}') { depth -= 1; if (depth === 0 && start >= 0) { out.push(q.slice(start, i + 1)); start = -1; } }
  }
  return out;
}

function selection(doc: string, field: string): string {
  const at = doc.indexOf(field);
  if (at < 0) return '';
  let i = doc.indexOf('{', at);
  if (i < 0) return '';
  let depth = 0; const s = i;
  for (; i < doc.length; i += 1) { if (doc[i] === '{') depth += 1; else if (doc[i] === '}') { depth -= 1; if (depth === 0) return doc.slice(s, i + 1); } }
  return '';
}
const wants = (sel: string, name: string): boolean => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(sel);

function repoOf(vars: Record<string, unknown>, doc: string): S.Repo | undefined {
  const owner = String(vars[String(rawArg(doc, 'owner') ?? 'owner')] ?? vars.owner ?? S.VIEWER);
  const name = String(vars[String(rawArg(doc, 'name') ?? 'name')] ?? vars.name ?? '');
  void owner;
  return S.allRepos().find((r) => r.name === name);
}
function rawArg(doc: string, arg: string): string | null {
  const m = doc.match(new RegExp(`${arg}: \\$(\\w+)`));
  return m ? m[1] : null;
}

function runOne(doc: string, vars: Record<string, unknown>): Gql {
  // introspection: one or more aliased __type probes
  if (/__type\(/.test(doc)) {
    const probes = [...doc.matchAll(/(?:([A-Za-z_]\w*)\s*:\s*)?__type\(name: "([A-Za-z_]\w*)"\)/g)];
    const out: Record<string, unknown> = {};
    for (const probe of probes) {
      const key = probe[1] ?? '__type';
      const t = probe[2];
      const fields = TYPE_FIELDS[t];
      if (!fields) { out[key] = null; continue; }
      const wantsEnum = /enumValues/.test(doc);
      out[key] = wantsEnum ? { enumValues: ['ISSUE', 'REPOSITORY', 'USER'].map((name) => ({ name })) } : { fields: fields.map((name) => ({ name })) };
    }
    return { data: out };
  }
  if (/\bviewer\s*{/.test(doc)) {
    if (wants(doc, 'noSuchFieldOnViewer')) return { data: { viewer: null }, errors: [{ message: 'Field noSuchFieldOnViewer does not exist on type User' }] };
    return { data: { viewer: { login: S.viewerLogin(), id: gid('R', 1) } } };
  }
  if (/\bnode\(/.test(doc)) {
    const id = String(vars.id ?? '');
    const parts = unGid(id);
    if (!parts) return { data: { node: null } };
    const [, n] = parts;
    const repo = S.allRepos().find((r) => (r as unknown as { id: number }).id === n);
    if (!repo) return { data: { node: null } };
    return { data: { node: { id, __typename: 'Repository', name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } } };
  }
  if (/\bcreateIssue\(/.test(doc)) {
    const input = (vars[String(rawArg(doc, 'input') ?? 'input')] ?? vars.input ?? {}) as Record<string, unknown>;
    const repo = S.findRepo(S.VIEWER, String(input.repository ?? '').split('/').pop() ?? '') ?? repoFromId(String(input.repositoryId ?? ''));
    if (!repo) return { data: { createIssue: { issue: null } } };
    const n = ++repo.counters.issue;
    const issue: S.Issue = { number: n, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open', labels: [], user: S.VIEWER, created_at: S.now(), updated_at: S.now(), closed_at: null };
    repo.issues.set(n, issue);
    return { data: { createIssue: { issue: { number: n, id: gid('I', n), state: 'OPEN', title: issue.title, body: issue.body } } } };
  }
  if (/\bcloseIssue\(/.test(doc)) {
    const input = (vars[String(rawArg(doc, 'input') ?? 'input')] ?? vars.input ?? {}) as Record<string, unknown>;
    const parts = unGid(String(input.issueId ?? ''));
    const repo = S.allRepos().find((r) => [...r.issues.values()].some((i) => gid('I', i.number) === input.issueId));
    const issue = repo && parts ? repo.issues.get(parts[1]) : undefined;
    if (!repo || !issue) return { data: { closeIssue: { issue: null } } };
    issue.state = 'closed'; issue.closed_at = S.now();
    return { data: { closeIssue: { issue: { number: issue.number, id: input.issueId, state: 'CLOSED' } } } };
  }
  if (/\bcreatePullRequest\(/.test(doc)) {
    const input = (vars[String(rawArg(doc, 'input') ?? 'input')] ?? vars.input ?? {}) as Record<string, unknown>;
    const repo = repoFromId(String(input.repositoryId ?? ''));
    if (!repo) return { data: { createPullRequest: { pullRequest: null } } };
    const n = ++repo.counters.pull;
    const head = String(input.headRefName ?? ''); const base = String(input.baseRefName ?? repo.default_branch);
    const p: S.Pull = { number: n, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open', head, base, merged: false, merge_commit_sha: null, merged_at: null, user: S.VIEWER, created_at: S.now() };
    repo.pulls.set(n, p);
    return { data: { createPullRequest: { pullRequest: { number: n, id: gid('P', n), state: 'OPEN', headRefName: head, baseRefName: base, mergeable: 'MERGEABLE' } } } };
  }
  if (/\bmergePullRequest\(/.test(doc)) {
    const input = (vars[String(rawArg(doc, 'input') ?? 'input')] ?? vars.input ?? {}) as Record<string, unknown>;
    const parts = unGid(String(input.pullRequestId ?? ''));
    const repo = parts ? S.allRepos().find((r) => r.pulls.has(parts[1])) : undefined;
    const pull = repo && parts ? repo.pulls.get(parts[1]) : undefined;
    if (!repo || !pull) return { data: { mergePullRequest: { pullRequest: null } } };
    const headSha = repo.refs.get(`refs/heads/${pull.head}`); const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
    if (headSha && baseSha && S.isAncestor(repo, baseSha, headSha)) {
      const info = S.commitInfo(repo, headSha);
      const author = `viewer <viewer@example.invalid> ${Math.floor(Date.now() / 1000)} +0000`;
      const commit = S.putObj(repo, 'commit', Buffer.from(`tree ${info?.tree}\nparent ${baseSha}\nparent ${headSha}\nauthor ${author}\ncommitter ${author}\n\nMerge pull request #${pull.number}\n`));
      repo.refs.set(`refs/heads/${pull.base}`, commit); pull.state = 'closed'; pull.merged = true; pull.merged_at = S.now(); pull.merge_commit_sha = commit;
    }
    return { data: { mergePullRequest: { pullRequest: { number: pull.number, merged: pull.merged, state: pull.merged ? 'MERGED' : 'OPEN' } } } };
  }
  if (/\baddComment\(/.test(doc)) {
    const input = (vars[String(rawArg(doc, 'input') ?? 'input')] ?? vars.input ?? {}) as Record<string, unknown>;
    const parts = unGid(String(input.subjectId ?? ''));
    const repo = parts ? S.allRepos().find((r) => r.issues.has(parts[1])) : undefined;
    if (!repo || !parts) return { data: { addComment: null } };
    const id = ++repo.counters.comment;
    const c: S.Comment = { id, body: String(input.body ?? ''), user: S.VIEWER, created_at: S.now() };
    repo.comments.set(parts[1], [...(repo.comments.get(parts[1]) ?? []), c]);
    return { data: { addComment: { commentEdge: { node: { id: gid('I', id), body: c.body } } } } };
  }
  if (/repository\(owner:/.test(doc)) {
    const repo = repoOf(vars, doc);
    if (!repo) return { data: { repository: null } };
    const d = (repo as unknown as { id: number }).id;
    if (wants(doc, 'issues')) {
      const first = Number(vars.first ?? doc.match(/first:\s*(\d+)/)?.[1] ?? 10);
      const after = String(vars.after ?? '');
      const start = after ? Number(Buffer.from(after, 'base64').toString()) || 0 : 0;
      const list = [...repo.issues.values()].filter((i) => i.state === 'open').sort((a, b) => b.number - a.number);
      const nodes = list.slice(start, start + first).map((i) => ({ number: i.number, title: i.title, state: 'OPEN', id: gid('I', i.number) }));
      const end = start + nodes.length < list.length ? Buffer.from(String(start + nodes.length)).toString('base64') : null;
      return { data: { repository: { issues: { nodes, pageInfo: { hasNextPage: end !== null, endCursor: end } } } } };
    }
    if (wants(doc, 'pullRequests')) {
      const first = Number(vars.first ?? doc.match(/first:\s*(\d+)/)?.[1] ?? 5);
      return { data: { repository: { pullRequests: { nodes: [...repo.pulls.values()].slice(0, first).map((p) => ({ number: p.number, headRefName: p.head, baseRefName: p.base, mergeable: 'MERGEABLE', state: p.merged ? 'MERGED' : 'OPEN' })) } } } };
    }
    if (wants(doc, 'pullRequest(')) {
      const number = Number(vars.number ?? doc.match(/pullRequest\(number: (\d+)\)/)?.[1] ?? 0);
      const p = repo.pulls.get(number);
      if (!p) return { data: { repository: { pullRequest: null } } };
      const headSha = repo.refs.get(`refs/heads/${p.head}`); const baseSha = repo.refs.get(`refs/heads/${p.base}`);
      const mt = headSha && baseSha ? mergeBaseOf(repo, baseSha, headSha) : null;
      const files = diffNames(repo, mt ? S.commitInfo(repo, mt)?.tree ?? null : null, headSha ? S.commitInfo(repo, headSha)?.tree ?? null : null);
      return { data: { repository: { pullRequest: { id: gid('P', p.number), number: p.number, files: { nodes: files.slice(0, 10).map((path) => ({ path })) } } } } };
    }
    if (wants(doc, 'issue(')) {
      const number = Number(vars.number ?? 0); const i = repo.issues.get(number);
      if (!i) return { data: { repository: { issue: null } } };
      return { data: { repository: { issue: { number: i.number, title: i.title, state: i.state === 'open' ? 'OPEN' : 'CLOSED', id: gid('I', i.number), body: i.body } } } };
    }
    return { data: { repository: { id: gid('R', d), databaseId: d, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}`, owner: { login: repo.owner }, defaultBranchRef: { name: repo.default_branch }, viewerPermission: 'ADMIN', hasIssuesEnabled: true } } };
  }
  return { data: { query: null } };
}

function repoFromId(id: string): S.Repo | undefined {
  const parts = unGid(id); if (!parts) return undefined;
  return S.allRepos().find((r) => (r as unknown as { id: number }).id === parts[1]);
}
function mergeBaseOf(repo: S.Repo, a: string, b: string): string | null {
  const anc = new Set(S.ancestors(repo, a)); const q = [b];
  while (q.length) { const s = q.shift()!; if (anc.has(s)) return s; const i = S.commitInfo(repo, s); if (i) q.push(...i.parents); }
  return null;
}
function diffNames(repo: S.Repo, a: string | null, b: string | null): string[] {
  const x = a ? S.flattenTree(repo, a) : new Map(); const y = b ? S.flattenTree(repo, b) : new Map();
  const out: string[] = [];
  for (const [p, e] of y) if (!x.has(p) || x.get(p)!.sha !== e.sha) out.push(p);
  for (const p of x.keys()) if (!y.has(p)) out.push(p);
  return out.sort();
}
function fieldName(doc: string): string {
  const m = doc.match(/(\w+): __type/);
  return m ? m[1] : '__type';
}
