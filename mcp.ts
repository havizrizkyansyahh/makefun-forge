// Minimal MCP streamable-HTTP endpoint: initialize, server/discover, tools/list, tools/call.
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as S from './store.ts';

const REV = '2026-07-28';
const TOOLS = [
  { name: 'create_repo', description: 'Create a repository for the viewer', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Read one repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Open an issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Open a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
];

interface Rpc { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }

function result(id: unknown, res: unknown): Record<string, unknown> { return { jsonrpc: '2.0', id: id ?? null, result: res }; }
function errRpc(id: unknown, code: number, message: string): Record<string, unknown> { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

function argOf(args: Record<string, unknown>, key: string): string { return String(args[key] ?? ''); }
function target(args: Record<string, unknown>): S.Repo | undefined {
  const full = argOf(args, 'full_name');
  if (full.includes('/')) { const [o, r] = full.split('/'); return S.findRepo(o, r) ?? S.allRepos().find((x) => x.name === r); }
  return S.findRepo(argOf(args, 'owner'), argOf(args, 'repo')) ?? S.allRepos().find((x) => x.name === argOf(args, 'repo'));
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, raw: Buffer, tokenOk: boolean): Promise<void> {
  const send = (status: number, body: unknown): void => {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (!tokenOk) return send(401, { message: 'Unauthorized' });
  let msg: Rpc;
  try { msg = JSON.parse(raw.toString()); } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const method = String(msg.method ?? '');
  const id = msg.id;
  if (method === 'initialize') {
    return send(200, result(id, { protocolVersion: REV, serverInfo: { name: 'makefun-forge', version: '1.0.0' }, capabilities: { tools: {} } }));
  }
  if (method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
  if (method === 'server/discover' || method === 'discover') {
    return send(200, result(id, {
      serverInfo: { name: 'makefun-forge', version: '1.0.0' },
      capabilities: { tools: {} },
      supportedVersions: [REV, '2025-11-25', '2025-06-18'],
      instructions: 'A GitHub-compatible forge over REST, git and GraphQL.',
    }));
  }
  if (method === 'tools/list') return send(200, result(id, { tools: TOOLS }));
  if (method === 'tools/call') {
    const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const name = String(params.name ?? '').toLowerCase().replace(/^[a-z0-9]+__/, '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return send(200, errRpc(id, -32602, `Unknown tool ${params.name ?? ''}`));
    for (const req2 of tool.inputSchema.required as string[]) {
      if (args[req2] === undefined || args[req2] === '') return send(200, { jsonrpc: '2.0', id: id ?? null, result: { isError: true, content: [{ type: 'text', text: `missing ${req2}` }] } });
    }
    const text = (): { content: { type: string; text: string }[]; isError?: boolean } => ({ content: [] });
    void text;
    if (name === 'create_repo') {
      const repo = S.createRepo(S.VIEWER, argOf(args, 'name'), false, argOf(args, 'description') || null);
      return send(200, result(id, { content: [{ type: 'text', text: JSON.stringify({ full_name: `${repo.owner}/${repo.name}`, id: (repo as unknown as { id: number }).id }) }] }));
    }
    const repo = target(args);
    if (!repo) return send(200, { ...result(id, { isError: true, content: [{ type: 'text', text: 'repository not found' }] }) });
    if (name === 'get_repo') return send(200, result(id, { content: [{ type: 'text', text: JSON.stringify({ full_name: `${repo.owner}/${repo.name}`, default_branch: repo.default_branch }) }] }));
    if (name === 'create_issue') {
      const n = ++repo.counters.issue;
      const i: S.Issue = { number: n, title: argOf(args, 'title'), body: argOf(args, 'body'), state: 'open', labels: [], user: S.VIEWER, created_at: S.now(), updated_at: S.now(), closed_at: null };
      repo.issues.set(n, i);
      return send(200, result(id, { content: [{ type: 'text', text: JSON.stringify({ number: n, title: i.title }) }] }));
    }
    if (name === 'list_issues') {
      const state = argOf(args, 'state') || 'open';
      const list = [...repo.issues.values()].filter((i) => state === 'all' || i.state === state).map((i) => ({ number: i.number, title: i.title, state: i.state }));
      return send(200, result(id, { content: [{ type: 'text', text: JSON.stringify(list) }] }));
    }
    if (name === 'create_pull_request') {
      const n = ++repo.counters.pull;
      const p: S.Pull = { number: n, title: argOf(args, 'title'), body: argOf(args, 'body'), state: 'open', head: argOf(args, 'head'), base: argOf(args, 'base') || repo.default_branch, merged: false, merge_commit_sha: null, merged_at: null, user: S.VIEWER, created_at: S.now() };
      repo.pulls.set(n, p);
      return send(200, result(id, { content: [{ type: 'text', text: JSON.stringify({ number: n, head: p.head, base: p.base }) }] }));
    }
    if (name === 'merge_pull_request') {
      const p = repo.pulls.get(Number(args.pull_number));
      if (!p) return send(200, errRpc(id, -32602, 'unknown pull request'));
      const headSha = repo.refs.get(`refs/heads/${p.head}`); const baseSha = repo.refs.get(`refs/heads/${p.base}`);
      if (headSha && baseSha && S.isAncestor(repo, baseSha, headSha)) {
        const info = S.commitInfo(repo, headSha);
        const author = `viewer <viewer@example.invalid> ${Math.floor(Date.now() / 1000)} +0000`;
        const commit = S.putObj(repo, 'commit', Buffer.from(`tree ${info?.tree}\nparent ${baseSha}\nparent ${headSha}\nauthor ${author}\ncommitter ${author}\n\nMerge pull request #${p.number}\n`));
        repo.refs.set(`refs/heads/${p.base}`, commit); p.state = 'closed'; p.merged = true; p.merged_at = S.now(); p.merge_commit_sha = commit;
      }
      return send(200, result(id, { content: [{ type: 'text', text: JSON.stringify({ merged: p.merged, number: p.number }) }] }));
    }
    return send(200, errRpc(id, -32601, 'Method not found'));
  }
  return send(200, errRpc(id, -32601, `Method not found: ${method}`));
}
