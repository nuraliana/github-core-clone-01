// The server: routes every request to the git, REST, GraphQL or MCP surface, or answers a
// JSON 404. main.ts (the env lifecycle) stays untouched; this file is the entry's app.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  requestCounter += 1;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}`,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const ctx = { store, token };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const service = gitMatch[3] as string;
          if (service === 'info/refs' && method === 'GET') {
            let serviceParam = '';
            try {
              serviceParam = new URL(req.url ?? '/', 'http://entry').searchParams.get('service') ?? '';
            } catch {
              serviceParam = '';
            }
            handleInfoRefs(req, res, ctx, owner, repoName, serviceParam);
            return;
          }
          if (service === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            handleUploadPack(req, res, ctx, owner, repoName, body);
            return;
          }
          if (service === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            handleReceivePack(req, res, ctx, owner, repoName, body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // GraphQL v4.
        if (method === 'POST' && path === '/api/graphql') {
          const body = await readBody(req);
          handleGraphQL(req, res, ctx, body);
          return;
        }

        // MCP.
        if (method === 'POST' && path === '/mcp') {
          const body = await readBody(req);
          handleMcp(req, res, ctx, body);
          return;
        }

        // REST v3 (reads the body for POST/PATCH/PUT/DELETE).
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
          const body = needsBody ? await readBody(req) : null;
          handleRest(req, res, ctx, body, path);
          return;
        }

        // Everything else: GitHub's JSON 404.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
