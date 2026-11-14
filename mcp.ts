// Model Context Protocol endpoint at /mcp (JSON-RPC 2.0, Streamable HTTP, stateless):
// modern 2026-07-28 `server/discover` and legacy 2025-11-25 `initialize` handshake both work.
// Six tools (github-mcp-server names) backed by the same store as REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import { pullConflict, squashMerge } from './rest.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

export interface McpContext {
  store: Store;
  token: string;
}

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-length': 0 });
  res.end();
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
  };
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): ToolResult {
  const store = ctx.store;
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) return errorResult(`Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return errorResult(`Missing required argument: ${required}`);
    }
  }
  const repoOf = (): Repo | null => {
    const owner = args.owner as string;
    const repoName = args.repo as string;
    if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
    return store.getRepo(owner, repoName) ?? null;
  };

  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      const description = typeof args.description === 'string' ? (args.description as string) : '';
      const isPrivate = args.private === true;
      const existing = store.getRepo(VIEWER.login, repoName);
      if (existing !== undefined) return okResult(repoJson(existing));
      const repo = store.createRepo(VIEWER.login, repoName, description, isPrivate);
      if (repo === null) return errorResult('A repository with that name already exists');
      return okResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = repoOf();
      if (repo === null) return errorResult('Not Found');
      return okResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoOf();
      if (repo === null) return errorResult('Not Found');
      const title = args.title as string;
      const bodyText = typeof args.body === 'string' ? (args.body as string) : '';
      const createdAt = store.timestamp();
      const issue: Issue = {
        number: repo.nextNumber,
        title,
        body: bodyText,
        state: 'open',
        labels: [],
        comments: [],
        created_seq: store.seq,
        created_at: createdAt,
        updated_at: createdAt,
      };
      repo.nextNumber += 1;
      repo.issues.push(issue);
      return okResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = repoOf();
      if (repo === null) return errorResult('Not Found');
      const state = typeof args.state === 'string' ? (args.state as string) : 'open';
      let list = [...repo.issues];
      if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.created_seq - a.created_seq);
      return okResult({ issues: list.map((i) => issueJson(repo, i)) });
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (repo === null) return errorResult('Not Found');
      const head = args.head as string;
      const base = args.base as string;
      const title = args.title as string;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        return errorResult('Validation Failed: head or base branch does not exist');
      }
      const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (duplicate !== undefined) return okResult(pullJson(repo, duplicate));
      const createdAt = store.timestamp();
      const pull: Pull = {
        number: repo.nextNumber,
        title,
        body: typeof args.body === 'string' ? (args.body as string) : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        created_seq: store.seq,
        created_at: createdAt,
      };
      repo.nextNumber += 1;
      repo.pulls.push(pull);
      return okResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (repo === null) return errorResult('Not Found');
      const number = typeof args.pull_number === 'number' ? (args.pull_number as number) : parseInt(String(args.pull_number), 10);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return errorResult('Not Found');
      if (pull.state !== 'open') return errorResult('Pull request is already closed');
      if (pullConflict(repo, pull)) return errorResult('This branch has conflicts that must be resolved');
      const sha = squashMerge(store, repo, pull);
      return okResult({ number: pull.number, merged: true, sha, state: 'closed' });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

export function handleMcp(req: IncomingMessage, res: ServerResponse, ctx: McpContext, body: Buffer | null): void {
  if ((req.headers.authorization ?? '') !== `Bearer ${ctx.token}`) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  if (body === null || body.length === 0) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: empty body' } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const request = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';

  // Notifications (no id) get a 202 with no body.
  if (id === null || id === undefined) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      sendEmpty(res, 202);
      return;
    }
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }

  const params = request.params !== null && typeof request.params === 'object' ? (request.params as Record<string, unknown>) : {};
  const result = (value: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result: value });
  const rpcError = (code: number, message: string): void =>
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      result({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
      return;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? (params.protocolVersion as string) : '';
      const chosen = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      result({
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    case 'tools/list':
      result({ tools: TOOLS });
      return;
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? (params.name as string) : '';
      const args = params.arguments !== null && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
      if (TOOLS.find((t) => t.name === toolName) === undefined) {
        rpcError(-32602, `Unknown tool: ${toolName}`);
        return;
      }
      result(callTool(ctx, toolName, args));
      return;
    }
    case 'ping':
      result({});
      return;
    default:
      rpcError(-32601, `Method not found: ${method}`);
  }
}
