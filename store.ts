// In-memory store + the git object model (SHA-1, trees, commits, tags, pack read/write,
// reachability with haves / shallow boundaries / deepen). No filesystem, no clock in state:
// every timestamp is derived from a deterministic sequence counter so a replay of the same
// requests reaches byte-identical state.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflate, deflateSync as zlibDeflate } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: a directory compares as its name with a trailing slash. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  let message = split < 0 ? '' : text.slice(split + 2);
  // A stored commit ends its message with one newline; the logical message does not.
  if (message.endsWith('\n')) message = message.slice(0, -1);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  let message = split < 0 ? '' : text.slice(split + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// --------------------------------------------------------------------------------------------
// Packs (plain objects only; the client sends plain packs and plain packs satisfy every check)
// --------------------------------------------------------------------------------------------

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = PACK_TYPE_CODES[type];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  const bytes: number[] = [];
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

export function writePack(objects: Iterable<GitObject & { oid: string }>): Buffer {
  const list = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(zlibDeflate(object.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  let size = byte & 0x0f;
  let shift = 4;
  let next = start + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[next] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    next += 1;
  }
  return { size, next, first: ((buffer[start] as number) >> 4) & 0x07 };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = byte & 0x7f;
  let next = start + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[next] as number;
    offset = ((offset + 1) << 7) | (byte & 0x7f);
    next += 1;
  }
  return { baseOffset: offset, next };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta source size ${sourceSize} != base ${base.length}`);
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta target size ${result.length} != ${targetSize}`);
  }
  return result;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a pack (plain entries + ofs/ref deltas) into an oid -> object map. */
export function readPack(pack: Buffer): PackReadResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  interface PendingDelta {
    at: number;
    baseOid?: string;
    baseOffset?: number;
    data: Buffer;
  }
  const pending: PendingDelta[] = [];
  for (let i = 0; i < count; i += 1) {
    const entryStart = offset;
    const { size, next, first: typeCode } = readVarintSize(pack, offset);
    offset = next;
    if (typeCode === 6 || typeCode === 7) {
      deltaCount += 1;
      let baseOid: string | undefined;
      let baseOffset: number | undefined;
      if (typeCode === 6) {
        const read = readOfsDeltaBase(pack, offset);
        baseOffset = entryStart - read.baseOffset;
        offset = read.next;
      } else {
        baseOid = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
      }
      const { data: inflated, next } = inflateAt(pack, offset, size);
      offset = next;
      pending.push({ at: entryStart, baseOid, baseOffset, data: inflated });
      void size;
    } else {
      const type = PACK_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, next } = inflateAt(pack, offset, size);
      offset = next;
      const oid = hashObject(type, data);
      const object: GitObject = { type, data };
      objects.set(oid, object);
      byOffset.set(entryStart, object);
    }
  }
  // Resolve deltas (possibly chained): iterate until no progress.
  const resolved = new Map<number, GitObject>();
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const item = pending[i] as PendingDelta;
      let base: GitObject | undefined;
      if (item.baseOid !== undefined) base = objects.get(item.baseOid);
      else if (item.baseOffset !== undefined) base = byOffset.get(item.baseOffset) ?? resolved.get(item.baseOffset);
      if (base === undefined) continue;
      const data = applyDelta(base.data, item.data);
      const oid = hashObject(base.type, data);
      const object: GitObject = { type: base.type, data };
      objects.set(oid, object);
      resolved.set(item.at, object);
      byOffset.set(item.at, object);
      pending.splice(i, 1);
      progress = true;
    }
  }
  if (pending.length > 0) throw new Error(`unresolved delta bases: ${pending.length}`);
  return { objects, deltaCount };
}

/** Adler-32 (the checksum a zlib stream carries as its last 4 bytes, big-endian). */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + (data[i] as number)) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate the zlib stream starting at `offset` and find where it ends. The stream's last 4
 * bytes are the Adler-32 of the uncompressed data, so the end is the position whose preceding
 * 4 bytes equal it; each candidate is verified by re-inflating exactly that slice (a chance
 * Adler match inside the deflate data cannot inflate to the same bytes). Falls back to the
 * binary search when the anchor is not found. Two inflates per object instead of ~20.
 */
function inflateAt(buffer: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  const data = zlibInflate(buffer.subarray(offset));
  if (data.length !== expectedSize) throw new Error(`pack object size ${data.length} != header ${expectedSize}`);
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(adler32(data), 0);
  for (let end = offset + 6; end <= buffer.length; end += 1) {
    if (
      buffer[end - 4] === adler[0] &&
      buffer[end - 3] === adler[1] &&
      buffer[end - 2] === adler[2] &&
      buffer[end - 1] === adler[3]
    ) {
      try {
        const check = zlibInflate(buffer.subarray(offset, end));
        if (check.equals(data)) return { data, next: end };
      } catch {
        // Not a stream end; keep scanning.
      }
    }
  }
  const consumed = inflateLength(buffer, offset);
  return { data: zlibInflate(buffer.subarray(offset, offset + consumed)), next: offset + consumed };
}

/** Bytes consumed by the zlib stream starting at `offset` (deflate streams have no length field). */
function inflateLength(buffer: Buffer, offset: number): number {
  // Node's inflateSync ignores trailing garbage and throws on a truncated stream, so
  // "inflates cleanly" is monotonic in the prefix length: false below the stream's end,
  // true at and above it. Exponential-probe for an upper bound, then binary-search the
  // minimal working length. The probe must be capped at the remaining length (a stream
  // ending between hi/2 and hi is missed if the probe jumps past hi untested).
  const tryInflate = (len: number): boolean => {
    try {
      zlibInflate(buffer.subarray(offset, offset + len));
      return true;
    } catch {
      return false;
    }
  };
  const hi = buffer.length - offset;
  if (hi < 2) throw new Error('cannot find end of zlib stream');
  let probe = 2;
  while (probe < hi && !tryInflate(probe)) probe = Math.min(probe * 2, hi);
  if (!tryInflate(probe)) throw new Error('cannot find end of zlib stream');
  let lo = 2;
  let high = probe;
  while (lo < high) {
    const mid = Math.floor((lo + high) / 2);
    if (tryInflate(mid)) high = mid;
    else lo = mid + 1;
  }
  return lo;
}

// --------------------------------------------------------------------------------------------
// Pkt-line framing
// --------------------------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim';
export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function encodePktLines(lines: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer into packets; throws on a malformed length. */
export function decodePktLines(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const length = parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > buffer.length) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(head)}`);
    }
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

// --------------------------------------------------------------------------------------------
// The store
// --------------------------------------------------------------------------------------------

export interface IssueLabel {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: IssueLabel[];
  comments: Array<{ id: number; body: string; created_at: string }>;
  created_seq: number;
  created_at: string;
  updated_at: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  created_seq: number;
  created_at: string;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  refs = new Map<string, string>();
  objects = new Map<string, GitObject>();
  labels = new Map<string, IssueLabel>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  nextNumber = 1;
  nextCommentId = 1;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  get headTarget(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  tip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  storeObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Flat path -> {mode, oid} map for the tree at `treeOid`. */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
    return out;
  }

  /** Build (and store) a tree from a flat path map; returns the root tree oid. */
  buildTreeFromMap(files: ReadonlyMap<string, { mode: string; oid: string }>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, file] of files) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: file.mode, name: rest, oid: file.oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const dir of dirs) {
        const sub = prefix === '' ? dir : `${prefix}/${dir}`;
        entries.push({ mode: '40000', name: dir, oid: build(sub) });
      }
      return this.storeObject('tree', buildTree(entries));
    };
    return build('');
  }

  /** Commits reachable from `tip` (newest-first DFS, parents in order), deduplicated. */
  commitsFrom(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      const view = parseCommit(object.data);
      for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i] as string);
    }
    return out;
  }

  /** Is `ancestor` an ancestor of (or equal to) `oid`? */
  isAncestor(ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      const view = parseCommit(object.data);
      for (const parent of view.parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** Peel a tag (or commit) oid to its commit oid; undefined when it is neither. */
  peelToCommit(oid: string): string | undefined {
    const object = this.objects.get(oid);
    if (object === undefined) return undefined;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      const view = parseTag(object.data);
      return this.peelToCommit(view.object);
    }
    return undefined;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  seq = 0;

  /** Deterministic timestamp: base + seq seconds (a replay of the same requests is identical). */
  timestamp(): string {
    this.seq += 1;
    return new Date(Date.UTC(2025, 0, 1, 0, 0, this.seq)).toISOString().replace('.000Z', 'Z');
  }

  /** Next commit epoch (seconds) for server-built commits. */
  commitEpoch(): number {
    this.seq += 1;
    return 1700000000 + this.seq;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo = new Repo(this.nextRepoId, owner, name, description, isPrivate);
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  viewerRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  }
}
