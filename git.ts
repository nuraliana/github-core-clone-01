// Git smart HTTP: info/refs (v0 + v2), upload-pack (v2 ls-refs/fetch, v0 fetch),
// receive-pack v0. Speaks only what the conformance client speaks, byte-exactly.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './scenario.ts';
import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
  type GitObject,
  type GitObjectType,
  type Repo,
  type Store,
} from './store.ts';

const AGENT = 'forge/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface GitContext {
  store: Store;
  token: string;
}

/** Send raw bytes with a content type. */
function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function isAuthorized(req: IncomingMessage, ctx: GitContext): boolean {
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${ctx.token}`;
}

/** Sorted ref list: heads then tags, each as [name, oid]. */
function listRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    refs.push({ name, oid });
  }
  return refs;
}

/** Peel an annotated tag ref to its commit (undefined for lightweight tags / non-tags). */
function peeledOf(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return undefined;
  return repo.peelToCommit(parseTag(object.data).object);
}

function headOid(repo: Repo): string | undefined {
  return repo.refs.get(repo.headTarget);
}

// --------------------------------------------------------------------------------------------
// info/refs
// --------------------------------------------------------------------------------------------

function advertiseV2(res: ServerResponse): void {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
    'object-info\n',
    'server-option\n',
  ];
  const body = Buffer.concat([encodePktLines(lines), pktFlush()]);
  sendRaw(res, 200, UPLOAD_AD, body);
}

function advertiseV0(res: ServerResponse, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const preamble = `# service=${service}\n`;
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${repo.headTarget} side-band-64k multi_ack_detailed thin-pack ofs-delta shallow agent=${AGENT}`
      : `symref=HEAD:${repo.headTarget} report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: Array<string | 'flush'> = [preamble];
  const refs = listRefs(repo);
  const head = headOid(repo);
  if (refs.length === 0 && head === undefined) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headLine = head ?? ZERO_OID;
    lines.push(`${headLine} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== undefined) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  const body = encodePktLines(lines);
  sendRaw(res, 200, service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD, body);
}

export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, ctx: GitContext, owner: string, repoName: string, service: string): void {
  if (!isAuthorized(req, ctx)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const repo = ctx.store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  if (wantsV2) advertiseV2(res);
  else advertiseV0(res, repo, service as 'git-upload-pack' | 'git-receive-pack');
}

// --------------------------------------------------------------------------------------------
// Fetch computation (shared by v2 and v0)
// --------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to send (oid -> object). */
  objects: Map<string, GitObject>;
  /** Commits at the depth boundary, to report as shallow. */
  shallow: string[];
  /** Client shallow boundaries whose parents are now sent. */
  unshallow: string[];
  /** Haves the server holds, to ACK (v2) / ACK (v0). */
  acks: string[];
}

function closureOf(repo: Repo, oid: string, out = new Map<string, GitObject>()): Map<string, GitObject> {
  const object = repo.objects.get(oid);
  if (object === undefined || out.has(oid)) return out;
  out.set(oid, object);
  if (object.type === 'commit') {
    const view = parseCommit(object.data);
    closureOfTreeFull(repo, view.tree, out);
    for (const parent of view.parents) closureOf(repo, parent, out);
  } else if (object.type === 'tree') {
    closureOfTreeFull(repo, oid, out);
  } else if (object.type === 'tag') {
    closureOf(repo, parseTag(object.data).object, out);
  }
  return out;
}

export function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowLines: string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(shallowLines);
  const normalHaves = new Set(haves.filter((h) => !shallowSet.has(h)));
  const shallowHaves = new Set(haves.filter((h) => shallowSet.has(h)));

  // BFS over commits from the wants, tracking the smallest generation each commit is seen at.
  const genOf = new Map<string, number>();
  const included = new Set<string>();
  const boundary = new Set<string>();
  const unshallow = new Set<string>();
  const tagWants: string[] = [];
  const queue: Array<{ oid: string; gen: number }> = [];
  const enqueue = (oid: string, gen: number): void => {
    const seen = genOf.get(oid);
    if (seen !== undefined && seen <= gen) return;
    genOf.set(oid, gen);
    queue.push({ oid, gen });
  };
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagWants.push(want);
      const target = parseTag(object.data).object;
      enqueue(target, 0);
    } else if (object.type === 'commit') {
      enqueue(want, 0);
    } else {
      // A blob/tree want: send the object itself.
      enqueue(want, 0);
    }
  }
  // BFS in generation order (queue is FIFO and gens only grow).
  for (let head = 0; head < queue.length; head += 1) {
    const { oid, gen } = queue[head] as { oid: string; gen: number };
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type !== 'commit') continue;
    if (normalHaves.has(oid)) continue;
    const view = parseCommit(object.data);
    if (shallowHaves.has(oid)) {
      // Already held (shallow): do not resend, but expand parents; unshallow if a parent is sent.
      for (const parent of view.parents) {
        enqueue(parent, gen + 1);
        const parentGen = genOf.get(parent);
        if (parentGen !== undefined && (depth === null || parentGen < depth) && !normalHaves.has(parent)) {
          unshallow.add(oid);
        }
      }
      continue;
    }
    if (depth !== null && gen >= depth) continue;
    included.add(oid);
    if (depth !== null && gen === depth - 1) boundary.add(oid);
    for (const parent of view.parents) enqueue(parent, gen + 1);
  }

  // Objects reachable from the included commits (stopping at non-included parents).
  const send = new Map<string, GitObject>();
  const visitTree = (treeOid: string): void => {
    const object = repo.objects.get(treeOid);
    if (object === undefined || send.has(treeOid) || object.type !== 'tree') return;
    send.set(treeOid, object);
    for (const entry of parseTree(object.data)) {
      const child = repo.objects.get(entry.oid);
      if (child === undefined) continue;
      if (child.type === 'tree') visitTree(entry.oid);
      else send.set(entry.oid, child);
    }
  };
  const visitCommit = (oid: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || send.has(oid) || object.type !== 'commit') return;
    send.set(oid, object);
    const view = parseCommit(object.data);
    visitTree(view.tree);
    for (const parent of view.parents) {
      if (included.has(parent)) visitCommit(parent);
    }
  };
  for (const oid of included) visitCommit(oid);
  for (const tagOid of tagWants) {
    const tag = repo.objects.get(tagOid);
    if (tag !== undefined) send.set(tagOid, tag);
    const target = tag !== undefined && tag.type === 'tag' ? parseTag(tag.data).object : undefined;
    if (target !== undefined && included.has(target)) {
      // Target commit closure already visited; the tag itself is in `send` above.
    }
  }
  // Non-commit wants (blob/tree) sent directly.
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object !== undefined && object.type !== 'commit' && object.type !== 'tag') {
      send.set(want, object);
      if (object.type === 'tree') visitTree(want);
    }
  }

  // Exclusion: everything the client already holds.
  const excluded = new Map<string, GitObject>();
  for (const have of normalHaves) closureOf(repo, have, excluded);
  for (const have of shallowHaves) {
    const object = repo.objects.get(have);
    if (object === undefined) continue;
    excluded.set(have, object);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      const treeOut = new Map<string, GitObject>();
      closureOfTreeFull(repo, view.tree, treeOut);
      for (const [oid, obj] of treeOut) excluded.set(oid, obj);
    }
  }
  for (const oid of [...excluded.keys()]) send.delete(oid);

  const acks: string[] = [];
  for (const have of haves) {
    if (repo.objects.has(have)) acks.push(have);
  }
  return {
    objects: send,
    shallow: [...boundary].filter((oid) => send.has(oid) || included.has(oid)),
    unshallow: [...unshallow],
    acks,
  };
}

function closureOfTreeFull(repo: Repo, treeOid: string, out: Map<string, GitObject>): void {
  const object = repo.objects.get(treeOid);
  if (object === undefined || out.has(treeOid) || object.type !== 'tree') return;
  out.set(treeOid, object);
  for (const entry of parseTree(object.data)) {
    const child = repo.objects.get(entry.oid);
    if (child === undefined) continue;
    if (child.type === 'tree') closureOfTreeFull(repo, entry.oid, out);
    else out.set(entry.oid, child);
  }
}

// --------------------------------------------------------------------------------------------
// Sideband framing (band 1 = pack data; at least one packet even for an empty pack)
// --------------------------------------------------------------------------------------------

function sideband(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.from([1])));
  } else {
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------------------------
// upload-pack
// --------------------------------------------------------------------------------------------

function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const lines: Array<string | 'flush'> = [];
  const head = headOid(repo);
  const refs = listRefs(repo);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (head === undefined) {
    if (args.unborn && keep('HEAD')) lines.push(`unborn HEAD symref-target:${repo.headTarget}\n`);
  } else {
    if (keep('HEAD')) {
      lines.push(args.symrefs ? `${head} HEAD symref-target:${repo.headTarget}\n` : `${head} HEAD\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel) {
        const peeled = peeledOf(repo, ref.oid);
        if (peeled !== undefined) line += ` peeled:${peeled}`;
      }
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function fetchV2Response(repo: Repo, wants: string[], haves: string[], shallowLines: string[], depth: number | null): Buffer {
  const plan = computeFetch(repo, wants, haves, shallowLines, depth);
  const pack = writePack([...plan.objects.entries()].map(([oid, object]) => ({ ...object, oid })));
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (haves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(pack));
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, wants: string[], haves: string[], shallowLines: string[], depth: number | null): Buffer {
  const plan = computeFetch(repo, wants, haves, shallowLines, depth);
  const pack = writePack([...plan.objects.entries()].map(([oid, object]) => ({ ...object, oid })));
  const parts: Buffer[] = [];
  if (haves.length === 0) parts.push(pktLine('NAK\n'));
  else if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else parts.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sideband(pack));
  return Buffer.concat(parts);
}

export function handleUploadPack(req: IncomingMessage, res: ServerResponse, ctx: GitContext, owner: string, repoName: string, body: Buffer): void {
  if (!isAuthorized(req, ctx)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const repo = ctx.store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  try {
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const packets = decodePktLines(body);
    const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
    if (!isV2) {
      // v0: wants section, flush, haves/done section.
      const wants: string[] = [];
      const haves: string[] = [];
      const shallowLines: string[] = [];
      let depth: number | null = null;
      for (const line of lines) {
        const text = line.replace(/\n$/, '');
        if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0] as string);
        else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) shallowLines.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7), 10);
      }
      if (wants.length === 0) {
        sendJson(res, 400, { message: 'no want lines' });
        return;
      }
      const out = fetchV0Response(repo, wants, haves, shallowLines, depth);
      sendRaw(res, 200, UPLOAD_RESULT, out);
      return;
    }
    // v2: command line, agent/object-format lines, delim, args.
    const command = (lines[0] ?? '').replace(/\n$/, '');
    const args = lines.slice(1);
    if (command === 'command=ls-refs') {
      const opts = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
      for (const arg of args) {
        const text = arg.replace(/\n$/, '');
        if (text === 'peel') opts.peel = true;
        else if (text === 'symrefs') opts.symrefs = true;
        else if (text === 'unborn') opts.unborn = true;
        else if (text.startsWith('ref-prefix ')) opts.prefixes.push(text.slice('ref-prefix '.length));
      }
      sendRaw(res, 200, UPLOAD_RESULT, lsRefsResponse(repo, opts));
      return;
    }
    if (command === 'command=fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallowLines: string[] = [];
      let depth: number | null = null;
      for (const arg of args) {
        const text = arg.replace(/\n$/, '');
        if (text.startsWith('want ')) wants.push(text.slice(5).trim());
        else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) shallowLines.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7), 10);
      }
      if (wants.length === 0) {
        sendRaw(res, 200, UPLOAD_RESULT, fetchV2Response(repo, [], haves, shallowLines, depth));
        return;
      }
      sendRaw(res, 200, UPLOAD_RESULT, fetchV2Response(repo, wants, haves, shallowLines, depth));
      return;
    }
    sendJson(res, 400, { message: `unknown v2 command ${JSON.stringify(command)}` });
  } catch (err) {
    sendJson(res, 400, { message: err instanceof Error ? err.message : 'malformed request' });
  }
}

// --------------------------------------------------------------------------------------------
// receive-pack
// --------------------------------------------------------------------------------------------

export function handleReceivePack(req: IncomingMessage, res: ServerResponse, ctx: GitContext, owner: string, repoName: string, body: Buffer): void {
  if (!isAuthorized(req, ctx)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const repo = ctx.store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  try {
    // Parse pkt-lines one at a time until the first flush; everything after it is the
    // raw pack (never pkt-framed) — decoding the whole body would choke on "PACK".
    const commandLines: string[] = [];
    let offset = 0;
    let sawFlush = false;
    while (offset + 4 <= body.length) {
      const head = body.subarray(offset, offset + 4).toString('ascii');
      if (head === '0000') {
        offset += 4;
        sawFlush = true;
        break;
      }
      if (head === '0001') {
        offset += 4;
        continue;
      }
      const length = parseInt(head, 16);
      if (!Number.isFinite(length) || length < 4 || offset + length > body.length) {
        throw new Error(`malformed pkt-line length ${JSON.stringify(head)}`);
      }
      commandLines.push(body.subarray(offset + 4, offset + length).toString('utf8'));
      offset += length;
    }
    if (!sawFlush) throw new Error('receive-pack: no flush after the command list');
    const packBytes = body.subarray(offset);

    interface Command {
      oldOid: string;
      newOid: string;
      ref: string;
    }
    const commands: Command[] = [];
    for (const raw of commandLines) {
      const line = raw.replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const clean = nul >= 0 ? line.slice(0, nul) : line;
      const parts = clean.split(' ');
      if (parts.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    if (commands.length === 0) throw new Error('receive-pack: empty command list');

    const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (updatesRef) {
      if (packBytes.length === 0) {
        unpackOk = false;
        unpackDetail = 'unpacker error: empty pack';
      } else {
        try {
          const { objects } = readPack(packBytes);
          for (const [oid, object] of objects) {
            if (!repo.objects.has(oid)) repo.objects.set(oid, object);
          }
        } catch (err) {
          unpackOk = false;
          unpackDetail = `unpacker error: ${err instanceof Error ? err.message : 'bad pack'}`;
        }
      }
    }

    const reportLines: string[] = [];
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = false;
      let reason = '';
      if (!unpackOk) {
        reason = 'unpack failed';
      } else if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) reason = 'cannot delete a ref that does not exist';
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'old value mismatch';
        else {
          repo.refs.delete(command.ref);
          ok = true;
        }
      } else if (command.oldOid === ZERO_OID) {
        if (current !== undefined) reason = 'already exists';
        else {
          const target = repo.objects.get(command.newOid);
          if (target === undefined) reason = 'object not found';
          else {
            repo.refs.set(command.ref, command.newOid);
            ok = true;
          }
        }
      } else {
        if (current === undefined) reason = 'cannot lock ref';
        else if (command.oldOid !== current) reason = 'old value mismatch';
        else {
          const target = repo.objects.get(command.newOid);
          if (target === undefined) reason = 'object not found';
          else if (command.ref.startsWith('refs/heads/') && !repo.isAncestor(current, command.newOid)) {
            reason = 'non-fast-forward';
          } else {
            repo.refs.set(command.ref, command.newOid);
            ok = true;
          }
        }
      }
      reportLines.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
    }

    const reportBody = encodePktLines([`unpack ${unpackOk ? 'ok' : unpackDetail}\n`, ...reportLines, 'flush']);
    const out = Buffer.concat([sideband(reportBody)]);
    sendRaw(res, 200, RECEIVE_RESULT, out);
  } catch (err) {
    sendJson(res, 400, { message: err instanceof Error ? err.message : 'malformed request' });
  }
}

export { VIEWER };
export type { GitObjectType };
export { hashObject };
