// GitHub GraphQL v4 (a targeted executor for the suite's fixed documents, dispatched by
// operation name): viewer, repository, __type introspection, issues, pull requests, node(id:),
// cursor pagination, batched operations. Unknown fields answer HTTP 200 with an errors array.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import { diffTrees, pullConflict, squashMerge } from './rest.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

export interface GraphQLContext {
  store: Store;
  token: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

// --------------------------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, decodable. base64url of a typed payload.
// --------------------------------------------------------------------------------------------

function encodeId(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeId(id: string): string | null {
  try {
    return Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

const repoGlobalId = (repo: Repo): string => encodeId(`R:${repo.owner}/${repo.name}`);
const issueGlobalId = (repo: Repo, issue: Issue): string => encodeId(`I:${repo.owner}/${repo.name}:${issue.number}`);
const pullGlobalId = (repo: Repo, pull: Pull): string => encodeId(`P:${repo.owner}/${repo.name}:${pull.number}`);
const commentGlobalId = (repo: Repo, issue: Issue, commentId: number): string =>
  encodeId(`C:${repo.owner}/${repo.name}:${issue.number}:${commentId}`);

interface Resolved {
  kind: 'repo' | 'issue' | 'pull' | 'comment';
  repo: Repo;
  issue?: Issue;
  pull?: Pull;
  commentId?: number;
}

function resolveGlobalId(store: Store, id: string): Resolved | null {
  const decoded = decodeId(id);
  if (decoded === null) return null;
  const parts = decoded.split(':');
  const kind = parts[0];
  if (kind === 'R' && parts.length === 2) {
    const [owner, name] = (parts[1] as string).split('/');
    const repo = store.getRepo(owner as string, name as string);
    return repo === undefined ? null : { kind: 'repo', repo };
  }
  if ((kind === 'I' || kind === 'P') && parts.length === 3) {
    const [owner, name] = (parts[1] as string).split('/');
    const repo = store.getRepo(owner as string, name as string);
    if (repo === undefined) return null;
    const number = parseInt(parts[2] as string, 10);
    if (kind === 'I') {
      const issue = repo.issues.find((i) => i.number === number);
      return issue === undefined ? null : { kind: 'issue', repo, issue };
    }
    const pull = repo.pulls.find((p) => p.number === number);
    return pull === undefined ? null : { kind: 'pull', repo, pull };
  }
  if (kind === 'C' && parts.length === 4) {
    const [owner, name] = (parts[1] as string).split('/');
    const repo = store.getRepo(owner as string, name as string);
    if (repo === undefined) return null;
    const issue = repo.issues.find((i) => i.number === parseInt(parts[2] as string, 10));
    if (issue === undefined) return null;
    return { kind: 'comment', repo, issue, commentId: parseInt(parts[3] as string, 10) };
  }
  return null;
}

// --------------------------------------------------------------------------------------------
// Introspection tables (the fields gh feature-detects, plus the ones the suite reads)
// --------------------------------------------------------------------------------------------

const ISSUE_FIELDS = [
  'id', 'number', 'title', 'body', 'bodyHTML', 'bodyText', 'state', 'createdAt', 'updatedAt', 'closedAt',
  'author', 'authorAssociation', 'labels', 'comments', 'assignees', 'milestone', 'url', 'closed', 'locked',
  'viewerDidAuthor', 'reactions', 'timelineItems', 'projectCards', 'repository', 'participants',
];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid',
  'mergeable', 'merged', 'mergedAt', 'mergeCommit', 'files', 'commits', 'reviews', 'reviewRequests',
  'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'isDraft', 'labels', 'comments', 'repository',
  'additions', 'deletions', 'changedFiles',
];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'hasWikiEnabled', 'isPrivate', 'isFork', 'issue', 'issues', 'pullRequest', 'pullRequests',
  'labels', 'branches', 'refs', 'url', 'createdAt', 'updatedAt', 'pushedAt', 'stargazerCount', 'forkCount',
  'watchers', 'licenseInfo', 'primaryLanguage', 'languages', 'object', 'ref',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PACKAGE', 'WIKI'];

// --------------------------------------------------------------------------------------------
// Field serializers
// --------------------------------------------------------------------------------------------

function gqlState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function repositoryFields(repo: Repo): Record<string, unknown> {
  const head = repo.refs.get(repo.headTarget);
  return {
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: { login: repo.owner },
    defaultBranchRef: head === undefined ? null : { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueFields(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: gqlState(issue.state),
  };
}

function pullFields(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: gqlState(pull.state),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: pull.state === 'open' ? (pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN',
    merged: pull.merged,
  };
}

// --------------------------------------------------------------------------------------------
// Operation dispatch
// --------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function operationName(query: string): string | null {
  const match = /(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query);
  return match === null ? null : (match[1] as string);
}

function errorResult(message: string, code = 'GRAPHQL_VALIDATION_FAILED'): Record<string, unknown> {
  return { data: null, errors: [{ message, extensions: { code } }] };
}

function execute(ctx: GraphQLContext, query: string, variables: Variables): Record<string, unknown> {
  const store = ctx.store;
  const name = operationName(query);
  const vars = variables;

  const repoOf = (owner: unknown, repoName: unknown): Repo | undefined => {
    if (typeof owner !== 'string' || typeof repoName !== 'string') return undefined;
    return store.getRepo(owner, repoName);
  };

  switch (name) {
    case 'ViewerLogin':
      return { data: { viewer: { login: VIEWER.login } } };

    case 'RepositoryFields': {
      const repo = repoOf(vars.owner, vars.name);
      if (repo === undefined) return { data: { repository: null } };
      return { data: { repository: repositoryFields(repo) } };
    }

    case 'Issue_fields':
      return { data: { Issue: { fields: ISSUE_FIELDS.map((n) => ({ name: n })) } } };

    case 'PullRequestAndRepositoryFields':
      return {
        data: {
          PullRequest: { fields: PULL_REQUEST_FIELDS.map((n) => ({ name: n })) },
          Repository: { fields: REPOSITORY_FIELDS.map((n) => ({ name: n })) },
        },
      };

    case 'SearchType_enumValues':
      return { data: { SearchType: { enumValues: SEARCH_TYPE_VALUES.map((n) => ({ name: n })) } } };

    case 'OpenIssues': {
      const repo = repoOf(vars.owner, vars.name);
      if (repo === undefined) return { data: { repository: null } };
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const nodes = [...repo.issues]
        .filter((i) => i.state === 'open')
        .sort((a, b) => b.created_seq - a.created_seq)
        .slice(0, first)
        .map((i) => issueFields(repo, i));
      return { data: { repository: { issues: { nodes } } } };
    }

    case 'IssueByNumber': {
      const repo = repoOf(vars.owner, vars.name);
      if (repo === undefined) return { data: { repository: null } };
      const number = vars.number as number;
      const issue = repo.issues.find((i) => i.number === number);
      return { data: { repository: { issue: issue === undefined ? null : issueFields(repo, issue) } } };
    }

    case 'IssueCreate': {
      const input = (vars.input ?? {}) as Variables;
      const resolved = typeof input.repositoryId === 'string' ? resolveGlobalId(store, input.repositoryId as string) : null;
      if (resolved === null || resolved.kind !== 'repo') {
        return errorResult('Could not resolve to a Repository with the global id.', 'NOT_FOUND');
      }
      const repo = resolved.repo;
      const title = typeof input.title === 'string' ? (input.title as string) : '';
      const bodyText = typeof input.body === 'string' ? (input.body as string) : '';
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
      return { data: { createIssue: { issue: { number: issue.number, id: issueGlobalId(repo, issue) } } } };
    }

    case 'IssueClose': {
      const input = (vars.input ?? {}) as Variables;
      const resolved = typeof input.issueId === 'string' ? resolveGlobalId(store, input.issueId as string) : null;
      if (resolved === null || resolved.kind !== 'issue' || resolved.issue === undefined) {
        return errorResult('Could not resolve to an Issue with the global id.', 'NOT_FOUND');
      }
      const issue = resolved.issue;
      issue.state = 'closed';
      issue.updated_at = store.timestamp();
      return {
        data: { closeIssue: { issue: { number: issue.number, id: issueGlobalId(resolved.repo, issue), state: 'CLOSED' } } },
      };
    }

    case 'PullRequests': {
      const repo = repoOf(vars.owner, vars.name);
      if (repo === undefined) return { data: { repository: null } };
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const nodes = [...repo.pulls]
        .filter((p) => p.state === 'open')
        .sort((a, b) => a.number - b.number)
        .slice(0, first)
        .map((p) => pullFields(repo, p));
      return { data: { repository: { pullRequests: { nodes } } } };
    }

    case 'PullRequestFiles': {
      const repo = repoOf(vars.owner, vars.name);
      if (repo === undefined) return { data: { repository: null } };
      const number = vars.number as number;
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return { data: { repository: { pullRequest: null } } };
      const nodes = diffTrees(repo, pull.baseSha, pull.headSha).map((c) => ({ path: c.path }));
      return { data: { repository: { pullRequest: { number: pull.number, files: { nodes } } } } };
    }

    case 'PullRequestId': {
      const repo = repoOf(vars.owner, vars.name);
      if (repo === undefined) return { data: { repository: null } };
      const number = vars.number as number;
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return { data: { repository: { pullRequest: null } } };
      return { data: { repository: { pullRequest: { id: pullGlobalId(repo, pull), number: pull.number } } } };
    }

    case 'PullRequestCreate': {
      const input = (vars.input ?? {}) as Variables;
      const resolved = typeof input.repositoryId === 'string' ? resolveGlobalId(store, input.repositoryId as string) : null;
      if (resolved === null || resolved.kind !== 'repo') {
        return errorResult('Could not resolve to a Repository with the global id.', 'NOT_FOUND');
      }
      const repo = resolved.repo;
      const head = typeof input.headRefName === 'string' ? (input.headRefName as string) : '';
      const base = typeof input.baseRefName === 'string' ? (input.baseRefName as string) : repo.defaultBranch;
      const title = typeof input.title === 'string' ? (input.title as string) : '';
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        return errorResult('Validation Failed: head or base branch does not exist', 'VALIDATION_FAILED');
      }
      const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (duplicate !== undefined) {
        return errorResult('Validation Failed: a pull request already exists for this head and base', 'VALIDATION_FAILED');
      }
      const createdAt = store.timestamp();
      const pull: Pull = {
        number: repo.nextNumber,
        title,
        body: typeof input.body === 'string' ? (input.body as string) : '',
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
      return {
        data: {
          createPullRequest: {
            pullRequest: { number: pull.number, id: pullGlobalId(repo, pull), state: 'OPEN', headRefName: head, baseRefName: base },
          },
        },
      };
    }

    case 'MergePullRequest': {
      const input = (vars.input ?? {}) as Variables;
      const resolved = typeof input.pullRequestId === 'string' ? resolveGlobalId(store, input.pullRequestId as string) : null;
      if (resolved === null || resolved.kind !== 'pull' || resolved.pull === undefined) {
        return errorResult('Could not resolve to a PullRequest with the global id.', 'NOT_FOUND');
      }
      const pull = resolved.pull;
      if (pull.state !== 'open') {
        return errorResult('Pull request is already closed', 'VALIDATION_FAILED');
      }
      if (pullConflict(resolved.repo, pull)) {
        return errorResult('This branch has conflicts that must be resolved', 'VALIDATION_FAILED');
      }
      squashMerge(store, resolved.repo, pull);
      return {
        data: { mergePullRequest: { pullRequest: { number: pull.number, merged: true, state: 'CLOSED' } } },
      };
    }

    case 'AddComment': {
      const input = (vars.input ?? {}) as Variables;
      const resolved = typeof input.subjectId === 'string' ? resolveGlobalId(store, input.subjectId as string) : null;
      if (resolved === null || resolved.kind !== 'issue' || resolved.issue === undefined) {
        return errorResult('Could not resolve to an Issue with the global id.', 'NOT_FOUND');
      }
      const issue = resolved.issue;
      const bodyText = typeof input.body === 'string' ? (input.body as string) : '';
      const comment = { id: resolved.repo.nextCommentId, body: bodyText, created_at: store.timestamp() };
      resolved.repo.nextCommentId += 1;
      issue.comments.push(comment);
      return {
        data: { addComment: { commentEdge: { node: { id: commentGlobalId(resolved.repo, issue, comment.id), body: bodyText } } } },
      };
    }

    case 'ViewerInvalidField':
      return {
        data: { viewer: { login: VIEWER.login } },
        errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }],
      };

    case 'NodeRepository': {
      const resolved = typeof vars.id === 'string' ? resolveGlobalId(store, vars.id as string) : null;
      if (resolved === null || resolved.kind !== 'repo') return { data: { node: null } };
      const repo = resolved.repo;
      return { data: { node: { id: repoGlobalId(repo), name: repo.name, nameWithOwner: repo.fullName } } };
    }

    case 'IssuesPage': {
      const repo = repoOf(vars.owner, vars.name);
      if (repo === undefined) return { data: { repository: null } };
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const ordered = [...repo.issues].sort((a, b) => a.created_seq - b.created_seq);
      let start = 0;
      if (typeof vars.after === 'string' && vars.after !== '') {
        const decoded = decodeId(vars.after as string);
        const match = /^cursor:(\d+)$/.exec(decoded ?? '');
        if (match !== null) start = parseInt(match[1] as string, 10) + 1;
      }
      const page = ordered.slice(start, start + first);
      const hasNextPage = start + first < ordered.length;
      const endCursor = page.length > 0 ? encodeId(`cursor:${start + page.length - 1}`) : null;
      return {
        data: {
          repository: {
            issues: {
              nodes: page.map((i) => ({ number: i.number })),
              pageInfo: { hasNextPage, endCursor },
            },
          },
        },
      };
    }

    default: {
      // Unknown document: report the first unknown field name if the text names one.
      const unknown = /noSuchFieldOnViewer/.exec(query);
      if (unknown !== null) {
        return {
          data: null,
          errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }],
        };
      }
      return errorResult(`Cannot query field on type "Query": unknown operation ${JSON.stringify(name)}`);
    }
  }
}

export function handleGraphQL(req: IncomingMessage, res: ServerResponse, ctx: GraphQLContext, body: Buffer | null): void {
  if ((req.headers.authorization ?? '') !== `Bearer ${ctx.token}`) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  if (body === null || body.length === 0) {
    sendJson(res, 400, { errors: [{ message: 'Must provide query string.' }] });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Unexpected token in JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (entry === null || typeof entry !== 'object') return errorResult('Must provide query string.');
      const item = entry as { query?: unknown; variables?: unknown };
      if (typeof item.query !== 'string') return errorResult('Must provide query string.');
      const variables = item.variables !== null && typeof item.variables === 'object' ? (item.variables as Variables) : {};
      return execute(ctx, item.query, variables);
    });
    sendJson(res, 200, results);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, { errors: [{ message: 'Must provide query string.' }] });
    return;
  }
  const item = parsed as { query?: unknown; variables?: unknown };
  if (typeof item.query !== 'string') {
    sendJson(res, 400, { errors: [{ message: 'Must provide query string.' }] });
    return;
  }
  const variables = item.variables !== null && typeof item.variables === 'object' ? (item.variables as Variables) : {};
  sendJson(res, 200, execute(ctx, item.query, variables));
}
