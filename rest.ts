// GitHub REST v3 surface: /api/v3 — repos, branches, commits, contents, labels, issues,
// pull requests. Every reply is application/json with a non-empty X-GitHub-Request-Id;
// errors are JSON {message}; no token is 401; another owner's name is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import {
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTree,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestContext {
  store: Store;
  token: string;
}

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  requestCounter += 1;
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}`,
    ...extraHeaders,
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function isAuthorized(req: IncomingMessage, ctx: RestContext): boolean {
  return (req.headers.authorization ?? '') === `Bearer ${ctx.token}`;
}

function parseQuery(url: string): URLSearchParams {
  try {
    return new URL(url, 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function paginate<T>(items: readonly T[], perPage: number, page: number): { pageItems: T[]; hasNext: boolean; total: number } {
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  return { pageItems, hasNext: start + perPage < items.length, total: items.length };
}

function linkHeader(req: IncomingMessage, basePath: string, query: URLSearchParams, perPage: number, page: number, hasNext: boolean): string {
  if (!hasNext) return '';
  const host = req.headers.host ?? '127.0.0.1';
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  return `<http://${host}${basePath}?${next.toString()}>; rel="next"`;
}

// --------------------------------------------------------------------------------------------
// Serializers
// --------------------------------------------------------------------------------------------

function repoJson(repo: Repo, store: Store): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.fullName}`,
    clone_url: `https://example.invalid/${repo.fullName}.git`,
    has_issues: true,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: '' })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
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
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    created_at: pull.created_at,
  };
}

// --------------------------------------------------------------------------------------------
// Line diff (small contents only; LCS on lines)
// --------------------------------------------------------------------------------------------

export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const m = a.length;
  const n = b.length;
  // LCS lengths, row by row (contents are small).
  let prev = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    const cur = new Array<number>(n + 1).fill(0);
    for (let j = 1; j <= n; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j] as number, cur[j - 1] as number);
    }
    prev = cur;
  }
  const lcs = prev[n] as number;
  return { additions: n - lcs, deletions: m - lcs };
}

// --------------------------------------------------------------------------------------------
// Contents commits
// --------------------------------------------------------------------------------------------

const AUTHOR_LINE = `${VIEWER.name} <${VIEWER.email}>`;

function buildContentsCommit(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; contentSha: string | null } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const parentTree = new Map<string, { mode: string; oid: string }>();
  if (tip !== undefined) {
    const commit = repo.objects.get(tip);
    if (commit !== undefined && commit.type === 'commit') {
      const view = parseCommit(commit.data);
      for (const [p, f] of repo.flattenTree(view.tree)) parentTree.set(p, f);
    }
  }
  let contentSha: string | null = null;
  if (content === null) {
    parentTree.delete(path);
  } else {
    contentSha = hashObject('blob', content);
    repo.storeObject('blob', content);
    parentTree.set(path, { mode: '100644', oid: contentSha });
  }
  const treeOid = repo.buildTreeFromMap(parentTree);
  const epoch = store.commitEpoch();
  const lines = [`tree ${treeOid}`];
  if (tip !== undefined) lines.push(`parent ${tip}`);
  lines.push(`author ${AUTHOR_LINE} ${epoch} +0000`);
  lines.push(`committer ${AUTHOR_LINE} ${epoch} +0000`);
  lines.push('');
  lines.push(message);
  const commitData = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  const commitSha = repo.storeObject('commit', commitData);
  repo.refs.set(ref, commitSha);
  return { commitSha, contentSha };
}

/** Resolve a ref query (?ref=) to a commit oid: branch name, or a 40-hex sha. */
function resolveRef(repo: Repo, ref: string | null): string | undefined {
  if (ref === null) return repo.refs.get(repo.headTarget);
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const object = repo.objects.get(ref.toLowerCase());
    if (object !== undefined && object.type === 'commit') return ref.toLowerCase();
    return undefined;
  }
  return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
}

// --------------------------------------------------------------------------------------------
// Pull-request diff + merge
// --------------------------------------------------------------------------------------------

interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

export function diffTrees(repo: Repo, baseCommit: string, headCommit: string): FileChange[] {
  const baseMap = new Map<string, { mode: string; oid: string }>();
  const headMap = new Map<string, { mode: string; oid: string }>();
  const baseObj = repo.objects.get(baseCommit);
  const headObj = repo.objects.get(headCommit);
  if (baseObj !== undefined && baseObj.type === 'commit') {
    for (const [p, f] of repo.flattenTree(parseCommit(baseObj.data).tree)) baseMap.set(p, f);
  }
  if (headObj !== undefined && headObj.type === 'commit') {
    for (const [p, f] of repo.flattenTree(parseCommit(headObj.data).tree)) headMap.set(p, f);
  }
  const changes: FileChange[] = [];
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    if (b === undefined && h !== undefined) changes.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b !== undefined && h === undefined) changes.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      changes.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
  }
  return changes;
}

export function blobText(repo: Repo, oid: string | null): string {
  if (oid === null) return '';
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

function pullFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const changes = diffTrees(repo, pull.baseSha, pull.headSha);
  return changes.map((change) => {
    const oldText = blobText(repo, change.oldOid);
    const newText = blobText(repo, change.newOid);
    const { additions, deletions } = lineDiff(oldText, newText);
    return {
      filename: change.path,
      status: change.status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: change.newOid ?? change.oldOid,
    };
  });
}

/** A pull is conflicted when a file it changes also changed on the base since its base sha. */
export function pullConflict(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined || baseTip === pull.baseSha) return false;
  const changes = diffTrees(repo, pull.baseSha, pull.headSha);
  const baseAtPr = new Map<string, string>();
  const baseNow = new Map<string, string>();
  const baseObj = repo.objects.get(pull.baseSha);
  const nowObj = repo.objects.get(baseTip);
  if (baseObj !== undefined && baseObj.type === 'commit') {
    for (const [p, f] of repo.flattenTree(parseCommit(baseObj.data).tree)) baseAtPr.set(p, f.oid);
  }
  if (nowObj !== undefined && nowObj.type === 'commit') {
    for (const [p, f] of repo.flattenTree(parseCommit(nowObj.data).tree)) baseNow.set(p, f.oid);
  }
  for (const change of changes) {
    const atPr = baseAtPr.get(change.path);
    const now = baseNow.get(change.path);
    if (now !== atPr && now !== change.newOid) return true;
  }
  return false;
}

// --------------------------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------------------------

export function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Buffer | null,
  path: string,
): boolean {
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const query = parseQuery(req.url ?? '/');
  const segments = path.split('/').filter((s) => s.length > 0); // ['api','v3',...]
  const rest = segments.slice(2);

  if (!isAuthorized(req, ctx)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }

  let jsonBody: Record<string, unknown> | null = null;
  if (body !== null && body.length > 0) {
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) jsonBody = parsed as Record<string, unknown>;
      else jsonBody = {};
    } catch {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
  }

  const getRepoOr404 = (owner: string, name: string): Repo | null => {
    const repo = ctx.store.getRepo(owner, name);
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return null;
    }
    return repo;
  };

  // GET /api/v3/ — root.
  if (method === 'GET' && rest.length === 0) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  // GET /api/v3/meta
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }
  // GET /api/v3/user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return true;
  }
  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const repos = ctx.store.viewerRepos(VIEWER.login);
      const { perPage, page } = pageParams(query);
      const { pageItems, hasNext } = paginate(repos, perPage, page);
      const link = linkHeader(req, '/api/v3/user/repos', query, perPage, page, hasNext);
      sendJson(res, 200, pageItems.map((r) => repoJson(r, ctx.store)), link === '' ? {} : { link });
      return true;
    }
    if (method === 'POST') {
      const name = typeof jsonBody?.name === 'string' ? (jsonBody.name as string) : '';
      if (name === '') {
        sendError(res, 422, 'Validation Failed: name is required');
        return true;
      }
      const description = typeof jsonBody?.description === 'string' ? (jsonBody.description as string) : '';
      const isPrivate = jsonBody?.private === true;
      const repo = ctx.store.createRepo(VIEWER.login, name, description, isPrivate);
      if (repo === null) {
        sendError(res, 422, `Validation Failed: name already exists on this account`);
        return true;
      }
      sendJson(res, 201, repoJson(repo, ctx.store));
      return true;
    }
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeURIComponent(rest[1] as string);
    const name = decodeURIComponent(rest[2] as string);
    const tail = rest.slice(3);

    // GET/DELETE/PATCH /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') {
        const repo = getRepoOr404(owner, name);
        if (repo === null) return true;
        sendJson(res, 200, repoJson(repo, ctx.store));
        return true;
      }
      if (method === 'PATCH') {
        const repo = getRepoOr404(owner, name);
        if (repo === null) return true;
        if (typeof jsonBody?.description === 'string') repo.description = jsonBody.description as string;
        sendJson(res, 200, repoJson(repo, ctx.store));
        return true;
      }
      if (method === 'DELETE') {
        const repo = getRepoOr404(owner, name);
        if (repo === null) return true;
        ctx.store.deleteRepo(owner, name);
        sendJson(res, 204, null);
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    const repo = getRepoOr404(owner, name);
    if (repo === null) return true;

    // GET /branches
    if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
      const list = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, list);
      return true;
    }
    // GET /branches/{branch}
    if (tail.length === 2 && tail[0] === 'branches' && method === 'GET') {
      const branch = decodeURIComponent(tail[1] as string);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return true;
    }
    // GET /git/refs/heads/{branch}
    if (tail.length === 4 && tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads' && method === 'GET') {
      const branch = decodeURIComponent(tail[3] as string);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
      return true;
    }
    // POST /git/refs
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && method === 'POST') {
      const ref = typeof jsonBody?.ref === 'string' ? (jsonBody.ref as string) : '';
      const sha = typeof jsonBody?.sha === 'string' ? (jsonBody.sha as string).toLowerCase() : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
        sendError(res, 422, 'Validation Failed: ref or sha is invalid');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Validation Failed: ref already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return true;
    }
    // GET /commits[?sha=]
    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const ref = query.get('sha');
      const tip = resolveRef(repo, ref);
      if (tip === undefined) {
        sendJson(res, 200, []);
        return true;
      }
      const list = repo.commitsFrom(tip).map((sha) => {
        const object = repo.objects.get(sha);
        const view = object !== undefined ? parseCommit(object.data) : null;
        return { sha, commit: { message: view?.message ?? '' } };
      });
      const { perPage, page } = pageParams(query);
      const { pageItems } = paginate(list, perPage, page);
      sendJson(res, 200, pageItems);
      return true;
    }
    // /contents/{path...}
    if (tail.length >= 2 && tail[0] === 'contents') {
      const filePath = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
      if (method === 'GET') {
        const ref = query.get('ref');
        const tip = resolveRef(repo, ref);
        if (tip === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const commit = repo.objects.get(tip);
        if (commit === undefined || commit.type !== 'commit') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const tree = repo.flattenTree(parseCommit(commit.data).tree);
        const entry = tree.get(filePath);
        if (entry !== undefined) {
          const blob = repo.objects.get(entry.oid);
          const content = blob !== undefined ? blob.data : Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: content.toString('base64'),
            sha: entry.oid,
            size: content.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
          });
          return true;
        }
        // Directory listing: immediate children of filePath.
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
        for (const [p, f] of tree) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash < 0) {
            children.set(rest, { type: 'file', name: rest, path: p, sha: f.oid });
          } else {
            const dir = rest.slice(0, slash);
            if (!children.has(dir)) {
              // Find the subtree oid for the sha: rebuild from the tree object.
              children.set(dir, { type: 'dir', name: dir, path: `${prefix}${dir}`, sha: dirTreeSha(repo, tip, `${prefix}${dir}`) });
            }
          }
        }
        if (children.size === 0) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
        return true;
      }
      if (method === 'PUT') {
        const message = typeof jsonBody?.message === 'string' ? (jsonBody.message as string) : 'update';
        const contentB64 = typeof jsonBody?.content === 'string' ? (jsonBody.content as string) : '';
        const branch = typeof jsonBody?.branch === 'string' ? (jsonBody.branch as string) : repo.defaultBranch;
        const givenSha = typeof jsonBody?.sha === 'string' ? (jsonBody.sha as string).toLowerCase() : undefined;
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          sendError(res, 422, 'Validation Failed: content is not valid base64');
          return true;
        }
        const ref = `refs/heads/${branch}`;
        const tip = repo.refs.get(ref);
        const current = currentFileSha(repo, tip, filePath);
        if (givenSha !== undefined && current !== givenSha) {
          sendError(res, 409, 'Conflict: sha does not match the current file');
          return true;
        }
        if (givenSha === undefined && current !== null) {
          sendError(res, 409, 'Conflict: sha is required to update an existing file');
          return true;
        }
        const isUpdate = current !== null;
        const { commitSha, contentSha } = buildContentsCommit(ctx.store, repo, branch, filePath, content, message);
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: contentSha, size: content.length, encoding: 'base64' },
          commit: { sha: commitSha },
        });
        return true;
      }
      if (method === 'DELETE') {
        const message = typeof jsonBody?.message === 'string' ? (jsonBody.message as string) : 'delete';
        const branch = typeof jsonBody?.branch === 'string' ? (jsonBody.branch as string) : repo.defaultBranch;
        const givenSha = typeof jsonBody?.sha === 'string' ? (jsonBody.sha as string).toLowerCase() : undefined;
        const ref = `refs/heads/${branch}`;
        const tip = repo.refs.get(ref);
        const current = currentFileSha(repo, tip, filePath);
        if (current === null) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (givenSha !== undefined && current !== givenSha) {
          sendError(res, 409, 'Conflict: sha does not match the current file');
          return true;
        }
        const { commitSha } = buildContentsCommit(ctx.store, repo, branch, filePath, null, message);
        sendJson(res, 200, { commit: { sha: commitSha } });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }
    // GET/POST /labels
    if (tail.length === 1 && tail[0] === 'labels') {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
        return true;
      }
      if (method === 'POST') {
        const name = typeof jsonBody?.name === 'string' ? (jsonBody.name as string) : '';
        const color = typeof jsonBody?.color === 'string' ? (jsonBody.color as string) : 'ededed';
        if (name === '') {
          sendError(res, 422, 'Validation Failed: name is required');
          return true;
        }
        const existing = repo.labels.get(name);
        if (existing !== undefined) {
          sendJson(res, 201, { name, color: existing.color, description: '' });
          return true;
        }
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { name, color, description: '' });
        return true;
      }
    }
    // /issues
    if (tail.length >= 1 && tail[0] === 'issues') {
      // POST /issues/{n}/comments and GET /issues/{n}/comments
      if (tail.length === 3 && tail[2] === 'comments') {
        const number = parseInt(tail[1] as string, 10);
        const issue = repo.issues.find((i) => i.number === number);
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'POST') {
          const bodyText = typeof jsonBody?.body === 'string' ? (jsonBody.body as string) : '';
          const comment = { id: repo.nextCommentId, body: bodyText, created_at: ctx.store.timestamp() };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, body: comment.body, created_at: comment.created_at, user: { login: VIEWER.login } });
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, created_at: c.created_at, user: { login: VIEWER.login } })));
          return true;
        }
      }
      // GET/PATCH /issues/{n}
      if (tail.length === 2) {
        const number = parseInt(tail[1] as string, 10);
        const issue = repo.issues.find((i) => i.number === number);
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          const state = jsonBody?.state;
          if (state === 'open' || state === 'closed') {
            issue.state = state;
            issue.updated_at = ctx.store.timestamp();
          }
          if (typeof jsonBody?.title === 'string') issue.title = jsonBody.title as string;
          if (typeof jsonBody?.body === 'string') issue.body = jsonBody.body as string;
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
      }
      // GET/POST /issues
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = typeof jsonBody?.title === 'string' ? (jsonBody.title as string) : '';
          const bodyText = typeof jsonBody?.body === 'string' ? (jsonBody.body as string) : '';
          const labelNames = Array.isArray(jsonBody?.labels) ? (jsonBody.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
          const labels: Array<{ name: string; color: string }> = [];
          for (const labelName of labelNames) {
            const label = repo.labels.get(labelName);
            if (label === undefined) {
              sendError(res, 422, `Validation Failed: label ${JSON.stringify(labelName)} does not exist`);
              return true;
            }
            labels.push(label);
          }
          const createdAt = ctx.store.timestamp();
          const issue: Issue = {
            number: repo.nextNumber,
            title,
            body: bodyText,
            state: 'open',
            labels,
            comments: [],
            created_seq: ctx.store.seq,
            created_at: createdAt,
            updated_at: createdAt,
          };
          repo.nextNumber += 1;
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.created_seq - b.created_seq : b.created_seq - a.created_seq));
          }
          const { perPage, page } = pageParams(query);
          const { pageItems, hasNext } = paginate(list, perPage, page);
          const link = linkHeader(req, `/api/v3/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`, query, perPage, page, hasNext);
          sendJson(res, 200, pageItems.map((i) => issueJson(repo, i)), link === '' ? {} : { link });
          return true;
        }
      }
      sendError(res, 404, 'Not Found');
      return true;
    }
    // /pulls
    if (tail.length >= 1 && tail[0] === 'pulls') {
      // GET /pulls/{n}/files
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const number = parseInt(tail[1] as string, 10);
        const pull = repo.pulls.find((p) => p.number === number);
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pullFiles(repo, pull));
        return true;
      }
      // PUT /pulls/{n}/merge
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        const number = parseInt(tail[1] as string, 10);
        const pull = repo.pulls.find((p) => p.number === number);
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (pull.state !== 'open') {
          sendError(res, 409, 'Pull request is already closed');
          return true;
        }
        if (pullConflict(repo, pull)) {
          sendError(res, 405, 'This branch has conflicts that must be resolved');
          return true;
        }
        const mergeSha = squashMerge(ctx.store, repo, pull);
        sendJson(res, 200, { sha: mergeSha, merged: true, message: `Pull request #${pull.number} successfully merged` });
        return true;
      }
      // GET /pulls/{n}
      if (tail.length === 2 && method === 'GET') {
        const number = parseInt(tail[1] as string, 10);
        const pull = repo.pulls.find((p) => p.number === number);
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pullJson(repo, pull));
        return true;
      }
      // GET/POST /pulls
      if (tail.length === 1) {
        if (method === 'POST') {
          const head = typeof jsonBody?.head === 'string' ? (jsonBody.head as string) : '';
          const base = typeof jsonBody?.base === 'string' ? (jsonBody.base as string) : repo.defaultBranch;
          const title = typeof jsonBody?.title === 'string' ? (jsonBody.title as string) : '';
          const bodyText = typeof jsonBody?.body === 'string' ? (jsonBody.body as string) : '';
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (headSha === undefined || baseSha === undefined) {
            sendError(res, 422, 'Validation Failed: head or base branch does not exist');
            return true;
          }
          const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
          if (duplicate !== undefined) {
            sendError(res, 422, 'Validation Failed: a pull request already exists for this head and base');
            return true;
          }
          const createdAt = ctx.store.timestamp();
          const pull: Pull = {
            number: repo.nextNumber,
            title,
            body: bodyText,
            state: 'open',
            headRef: head,
            baseRef: base,
            headSha,
            baseSha,
            merged: false,
            merged_at: null,
            merge_commit_sha: null,
            created_seq: ctx.store.seq,
            created_at: createdAt,
          };
          repo.nextNumber += 1;
          repo.pulls.push(pull);
          sendJson(res, 201, pullJson(repo, pull));
          return true;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
          list.sort((a, b) => a.number - b.number);
          const { perPage, page } = pageParams(query);
          const { pageItems, hasNext } = paginate(list, perPage, page);
          const link = linkHeader(req, `/api/v3/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`, query, perPage, page, hasNext);
          sendJson(res, 200, pageItems.map((p) => pullJson(repo, p)), link === '' ? {} : { link });
          return true;
        }
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    sendError(res, 404, 'Not Found');
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}

function currentFileSha(repo: Repo, tip: string | undefined, filePath: string): string | null {
  if (tip === undefined) return null;
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return null;
  const entry = repo.flattenTree(parseCommit(commit.data).tree).get(filePath);
  return entry === undefined ? null : entry.oid;
}

/** The tree oid of a directory at `dirPath` in the tree of commit `tip` (zero oid when absent). */
function dirTreeSha(repo: Repo, tip: string, dirPath: string): string {
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return ZERO_OID;
  let current = parseCommit(commit.data).tree;
  const parts = dirPath.split('/').filter((p) => p !== '');
  for (const part of parts) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return ZERO_OID;
    const entry = parseTree(object.data).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return ZERO_OID;
    current = entry.oid;
  }
  return current;
}

/** Squash-merge a pull: one commit on the base branch carrying the head's changed files. */
export function squashMerge(store: Store, repo: Repo, pull: Pull): string {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) as string;
  const baseObj = repo.objects.get(baseTip);
  const files = new Map<string, { mode: string; oid: string }>();
  if (baseObj !== undefined && baseObj.type === 'commit') {
    for (const [p, f] of repo.flattenTree(parseCommit(baseObj.data).tree)) files.set(p, f);
  }
  for (const change of diffTrees(repo, pull.baseSha, pull.headSha)) {
    if (change.status === 'removed') files.delete(change.path);
    else if (change.newOid !== null) files.set(change.path, { mode: '100644', oid: change.newOid });
  }
  const treeOid = repo.buildTreeFromMap(files);
  const epoch = store.commitEpoch();
  const lines = [
    `tree ${treeOid}`,
    `parent ${baseTip}`,
    `author ${AUTHOR_LINE} ${epoch} +0000`,
    `committer ${AUTHOR_LINE} ${epoch} +0000`,
    '',
    pull.title,
  ];
  const commitSha = repo.storeObject('commit', Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = store.timestamp();
  pull.merge_commit_sha = commitSha;
  return commitSha;
}
