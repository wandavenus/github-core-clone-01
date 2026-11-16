// A GitHub-compatible git forge in one process, standard library only.
//
// Four surfaces share one in-memory store:
//   - git smart HTTP (protocol v2 upload-pack, v0 receive-pack) at /<owner>/<repo>.git
//   - REST v3 under /api/v3
//   - GraphQL v4 at POST /api/graphql
//   - MCP streamable HTTP at POST /mcp
//
// Git objects are real git objects: ids are SHA-1 over "<type> <size>\0" + bytes, packs are
// version-2 packfiles (plain entries plus ofs/ref delta resolution on read), and every ref
// update is checked for fast-forward ancestry. State is deterministic: ids are sequential
// counters and timestamps derive from a fixed epoch plus a per-process counter, never the
// wall clock.

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const ZERO_OID = '0'.repeat(40);
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const VIEWER_ID = 1000;
const DEFAULT_BRANCH = 'main';
const FORGE_IDENTITY = 'Forge <forge@example.invalid>';
const EPOCH_BASE = 1_735_689_600;
const MCP_REVISIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18'];

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

let stampCounter = 0;
function nextStamp(): string {
  stampCounter += 1;
  return new Date((EPOCH_BASE + stampCounter) * 1000).toISOString();
}
function nextEpochSec(): number {
  stampCounter += 1;
  return EPOCH_BASE + stampCounter;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authed(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (token === '') return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
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

function parseJsonBody(raw: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const text = raw.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return { ok: true, value };
    return { ok: true, value: { value } };
  } catch {
    return { ok: false };
  }
}

// ------------------------------------------------------------------ git objects

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const view: CommitView = {
    tree: '',
    parents: [],
    author: '',
    committer: '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

function buildCommit(tree: string, parents: readonly string[], message: string, epochSec: number): Buffer {
  const who = `${FORGE_IDENTITY} ${epochSec} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const text = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${text}`, 'utf8');
}

function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  let object = '';
  let type = '';
  let tag = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
    else if (key === 'tag') tag = value;
  }
  return { object, type, tag };
}

// ------------------------------------------------------------------ packfiles

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] ?? 0;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset] ?? 0;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack size varint too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] ?? 0;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset] ?? 0;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] ?? 0;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] ?? 0) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] ?? 0) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

function readPack(pack: Buffer): GitObject[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolvedByOid = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): GitObject => {
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let object: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (baseEntry === undefined) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const base = resolvedByOid.get(entry.baseOid ?? '');
      if (base === undefined) throw new Error('ref-delta base missing');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: CODE_TYPE[entry.typeCode] as GitObjectType, data: entry.data };
    }
    resolving.delete(entry.offset);
    resolvedByOid.set(hashObject(object.type, object.data), object);
    return object;
  };
  return raw.map((entry) => resolve(entry));
}

// ------------------------------------------------------------------ pkt-lines

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface PktPacket {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

function decodePktLines(bytes: Buffer, startAt = 0): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = startAt;
  while (offset + 4 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('bad pkt-line header');
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      return { packets, rest: bytes.subarray(offset) };
    }
    if (length === 1 || length === 2) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > bytes.length) throw new Error('pkt-line overruns the body');
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: bytes.subarray(offset) };
}

// ------------------------------------------------------------------ the store

interface LabelRec {
  name: string;
  color: string;
}

interface CommentRec {
  gid: number;
  body: string;
  createdAt: string;
}

interface IssueRec {
  gid: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

interface PullRec {
  gid: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
}

interface Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextGid = 1;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function findRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return repos.get(repoKey(owner, name)) ?? null;
}

function createRepoRecord(name: string, isPrivate: boolean, description: string): Repo {
  const stamp = nextStamp();
  const repo: Repo = {
    id: nextRepoId,
    name,
    owner: VIEWER_LOGIN,
    isPrivate,
    description,
    defaultBranch: DEFAULT_BRANCH,
    createdAt: stamp,
    updatedAt: stamp,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
  };
  nextRepoId += 1;
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function getCommit(repo: Repo, oid: string): CommitView | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

/** Flatten a tree (recursively) into a path -> entry map. */
function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, TreeEntry>()): Map<string, TreeEntry> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, name: path, oid: entry.oid });
  }
  return out;
}

function flatTreeOfCommit(repo: Repo, commitOid: string): Map<string, TreeEntry> {
  const commit = getCommit(repo, commitOid);
  if (commit === null) return new Map();
  return flattenTree(repo, commit.tree);
}

/** Build nested tree objects from a flat path -> blob-oid map; returns the root tree oid. */
function buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      if (!node.dirs.has(segment)) node.dirs.set(segment, make());
      node = node.dirs.get(segment) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Create a commit on a branch from a flat tree; returns the commit oid. */
function commitFlatTree(repo: Repo, branch: string, flat: ReadonlyMap<string, { mode: string; oid: string }>, message: string): string {
  const tree = buildTreeFromFlat(repo, flat);
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const data = buildCommit(tree, parent === undefined ? [] : [parent], message, nextEpochSec());
  const oid = putObject(repo, 'commit', data);
  repo.refs.set(ref, oid);
  return oid;
}

/** Every object reachable from roots; commits in `cut` are included but their parents are not walked. */
function reachable(repo: Repo, roots: Iterable<string>, cut: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!cut.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Ancestor commit oids of a commit (itself included), breadth-first. */
function ancestors(repo: Repo, tip: string): Map<string, number> {
  const depth = new Map<string, number>();
  const queue: Array<[string, number]> = [[tip, 0]];
  while (queue.length > 0) {
    const [oid, d] = queue.shift() as [string, number];
    if (depth.has(oid)) continue;
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    depth.set(oid, d);
    for (const parent of commit.parents) queue.push([parent, d + 1]);
  }
  return depth;
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return ancestors(repo, descendant).has(ancestor);
}

function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = ancestors(repo, a);
  const fromB = ancestors(repo, b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, d] of fromA) {
    const other = fromB.get(oid);
    if (other !== undefined && d + other < bestScore) {
      bestScore = d + other;
      best = oid;
    }
  }
  return best;
}

/** Peel a tag chain down to the commit it names (or the object itself when it is not a tag). */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  let lines = 0;
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lines += 1;
  return text.endsWith('\n') ? lines : lines + 1;
}

/** The file-level diff between two flat trees. */
function diffFlat(repo: Repo, base: ReadonlyMap<string, TreeEntry>, head: ReadonlyMap<string, TreeEntry>): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const beforeData = before === undefined ? null : repo.objects.get(before.oid)?.data ?? null;
    const afterData = after === undefined ? null : repo.objects.get(after.oid)?.data ?? null;
    const additions = afterData === null ? 0 : countLines(afterData);
    const deletions = beforeData === null ? 0 : countLines(beforeData);
    changes.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

interface MergeOutcome {
  ok: boolean;
  sha: string | null;
}

/**
 * Squash-merge the head branch into the base branch: the head side's changes relative to the
 * merge base are applied onto the base tip as one new commit. A path changed on both sides to
 * different contents is a conflict.
 */
function squashMerge(repo: Repo, pull: PullRec): MergeOutcome {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const base = mergeBase(repo, baseTip, headTip);
  const baseFlat = base === null ? new Map<string, TreeEntry>() : flatTreeOfCommit(repo, base);
  const oursFlat = flatTreeOfCommit(repo, baseTip);
  const theirsFlat = flatTreeOfCommit(repo, headTip);
  const merged = new Map<string, { mode: string; oid: string }>();
  for (const [path, entry] of oursFlat) merged.set(path, { mode: entry.mode, oid: entry.oid });
  const paths = new Set<string>([...baseFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const atBase = baseFlat.get(path);
    const atTheirs = theirsFlat.get(path);
    if (atBase !== undefined && atTheirs !== undefined && atBase.oid === atTheirs.oid) continue;
    if (atBase === undefined && atTheirs === undefined) continue;
    const atOurs = oursFlat.get(path);
    const oursChanged = (atOurs?.oid ?? null) !== (atBase?.oid ?? null);
    if (oursChanged && (atOurs?.oid ?? null) !== (atTheirs?.oid ?? null)) return { ok: false, sha: null };
    if (atTheirs === undefined) merged.delete(path);
    else merged.set(path, { mode: atTheirs.mode, oid: atTheirs.oid });
  }
  const tree = buildTreeFromFlat(repo, merged);
  const data = buildCommit(tree, [baseTip], `${pull.title}\n`, nextEpochSec());
  const sha = putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  return { ok: true, sha };
}

/** Whether merging head into base right now would conflict (a dry run of squashMerge's test). */
function mergeWouldConflict(repo: Repo, headRef: string, baseRef: string): boolean {
  const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${headRef}`);
  if (baseTip === undefined || headTip === undefined) return false;
  const base = mergeBase(repo, baseTip, headTip);
  const baseFlat = base === null ? new Map<string, TreeEntry>() : flatTreeOfCommit(repo, base);
  const oursFlat = flatTreeOfCommit(repo, baseTip);
  const theirsFlat = flatTreeOfCommit(repo, headTip);
  const paths = new Set<string>([...baseFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const atBase = baseFlat.get(path);
    const atTheirs = theirsFlat.get(path);
    if ((atBase?.oid ?? null) === (atTheirs?.oid ?? null)) continue;
    const atOurs = oursFlat.get(path);
    const oursChanged = (atOurs?.oid ?? null) !== (atBase?.oid ?? null);
    if (oursChanged && (atOurs?.oid ?? null) !== (atTheirs?.oid ?? null)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ serializers

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `/${repo.owner}/${repo.name}`,
    git_url: `/${repo.owner}/${repo.name}.git`,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    has_issues: true,
    has_pull_requests: true,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function labelJson(label: LabelRec): Record<string, unknown> {
  return { name: label.name, color: label.color, description: null, default: false };
}

function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.gid,
    node_id: globalId('Issue', issue.gid),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    pull_request: undefined,
  };
}

function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.gid,
    node_id: globalId('IssueComment', comment.gid),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = pull.merged ? pull.baseSha : repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.gid,
    node_id: globalId('PullRequest', pull.gid),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? !mergeWouldConflict(repo, pull.headRef, pull.baseRef) : null,
    draft: false,
    locked: false,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Opaque Relay-style global id: base64 of "<Type>:<numeric id>"; never the plain number. */
function globalId(type: string, numericId: number): string {
  return Buffer.from(`${type}:${numericId}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; numericId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.lastIndexOf(':');
    if (colon <= 0) return null;
    const numericId = Number(text.slice(colon + 1));
    if (!Number.isSafeInteger(numericId)) return null;
    return { type: text.slice(0, colon), numericId };
  } catch {
    return null;
  }
}

function createIssueRecord(repo: Repo, title: string, body: string, labels: string[]): IssueRec {
  const stamp = nextStamp();
  const issue: IssueRec = {
    gid: nextGid,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: stamp,
    updatedAt: stamp,
  };
  nextGid += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

function createPullRecord(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRec | null {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const stamp = nextStamp();
  const pull: PullRec = {
    gid: nextGid,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    headSha,
    baseSha,
    createdAt: stamp,
    updatedAt: stamp,
  };
  nextGid += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Perform a merge on a pull request; shared by REST, GraphQL and MCP. */
function mergePullRecord(repo: Repo, pull: PullRec): { ok: true; sha: string } | { ok: false; conflict: boolean } {
  if (pull.state !== 'open') return { ok: false, conflict: false };
  const outcome = squashMerge(repo, pull);
  if (!outcome.ok || outcome.sha === null) return { ok: false, conflict: true };
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nextStamp();
  pull.updatedAt = pull.mergedAt;
  pull.mergeCommitSha = outcome.sha;
  pull.baseSha = outcome.sha;
  return { ok: true, sha: outcome.sha };
}

function pullFiles(repo: Repo, pull: PullRec): FileChange[] {
  const baseTip = pull.merged ? pull.baseSha : repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  // Diff the merge base against the head so a moved base does not invent changes.
  const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
  return diffFlat(repo, flatTreeOfCommit(repo, base), flatTreeOfCommit(repo, headTip));
}

// ------------------------------------------------------------------ REST v3

interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  host: string;
}

function bodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function resolveCommitRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const branchTip = repo.refs.get(`refs/heads/${ref}`);
  if (branchTip !== undefined) return branchTip;
  if (/^[0-9a-f]{40}$/i.test(ref) && repo.objects.has(ref.toLowerCase())) return ref.toLowerCase();
  const anyRef = repo.refs.get(ref);
  if (anyRef !== undefined) return anyRef;
  return null;
}

function listCommits(repo: Repo, startOid: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const queue: string[] = [startOid];
  while (queue.length > 0 && out.length < 1000) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({
      sha: oid,
      node_id: globalId('Commit', 0) + oid.slice(0, 8),
      commit: {
        message: commit.message.replace(/\n$/, ''),
        author: { name: FORGE_IDENTITY.split(' <')[0], email: 'forge@example.invalid' },
        committer: { name: FORGE_IDENTITY.split(' <')[0], email: 'forge@example.invalid' },
        tree: { sha: commit.tree },
      },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

function handleRest(req: IncomingMessage, res: ServerResponse, rq: RestRequest): void {
  const { method, segments, query, body } = rq;
  const send = (status: number, value: unknown, headers?: Record<string, string>): void => sendJson(res, status, value, headers);

  // Root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound(res);
    return send(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return notFound(res);
    return send(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return notFound(res);
    return send(200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
  }

  // The viewer's repository list (with Link pagination) and creation.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const name = bodyString(body, 'name');
      if (name === undefined || name === '') return send(422, { message: 'Validation Failed: name is required' });
      if (repos.has(repoKey(VIEWER_LOGIN, name))) {
        return send(422, { message: `name already exists on this account: ${name} already exists` });
      }
      const isPrivate = typeof body.private === 'boolean' ? body.private : false;
      const description = bodyString(body, 'description') ?? '';
      const repo = createRepoRecord(name, isPrivate, description);
      return send(201, repoJson(repo));
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const all = [...repos.values()].filter((repo) => repo.owner === VIEWER_LOGIN).sort((a, b) => a.id - b.id);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        const nextUrl = `http://${rq.host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        const lastUrl = `http://${rq.host}/api/v3/user/repos?per_page=${perPage}&page=${Math.ceil(all.length / perPage)}`;
        headers.link = `<${nextUrl}>; rel="next", <${lastUrl}>; rel="last"`;
      }
      return send(200, slice.map((repo) => repoJson(repo)), headers);
    }
    return notFound(res);
  }

  if (segments[0] !== 'repos' || segments.length < 3) return notFound(res);
  const owner = segments[1] as string;
  const repoName = segments[2] as string;
  const rest = segments.slice(3);
  const repo = findRepo(owner, repoName);
  if (repo === null) return send(404, { message: 'Not Found' });
  const repoPath = `/api/v3/repos/${owner}/${repoName}`;

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return send(200, repoJson(repo));
    if (method === 'PATCH') {
      const description = bodyString(body, 'description');
      if (description !== undefined) repo.description = description;
      const name = bodyString(body, 'name');
      if (name !== undefined && name !== repo.name) {
        repos.delete(repoKey(repo.owner, repo.name));
        repo.name = name;
        repos.set(repoKey(repo.owner, repo.name), repo);
      }
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      repo.updatedAt = nextStamp();
      return send(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      repos.delete(repoKey(repo.owner, repo.name));
      return send(204, null);
    }
    return notFound(res);
  }

  // Branches.
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches: Array<Record<string, unknown>> = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
    }
    branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return send(200, branches);
  }
  if (rest[0] === 'branches' && rest.length >= 2 && method === 'GET') {
    const branch = rest.slice(1).join('/');
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) return send(404, { message: 'Branch not found' });
    return send(200, { name: branch, commit: { sha: oid }, protected: false });
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const start = resolveCommitRef(repo, query.get('sha') ?? undefined);
    if (start === null) return send(200, []);
    return send(200, listCommits(repo, start));
  }
  if (rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
    const oid = (rest[1] as string).toLowerCase();
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return send(404, { message: 'Not Found' });
    const commit = parseCommit(object.data);
    return send(200, { sha: oid, commit: { message: commit.message.replace(/\n$/, ''), tree: { sha: commit.tree } }, parents: commit.parents.map((p) => ({ sha: p })) });
  }

  // Git refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = bodyString(body, 'ref');
      const sha = bodyString(body, 'sha')?.toLowerCase();
      if (ref === undefined || sha === undefined || !repo.objects.has(sha)) {
        return send(422, { message: 'Validation Failed: ref or sha is invalid' });
      }
      repo.refs.set(ref, sha);
      return send(201, { ref, node_id: globalId('Ref', repo.id), object: { sha, type: 'commit' } });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return send(404, { message: 'Not Found' });
      return send(200, { ref, node_id: globalId('Ref', repo.id), object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
    }
    if (method === 'GET' && rest.length === 2) {
      const list: Array<Record<string, unknown>> = [];
      for (const [ref, oid] of repo.refs) list.push({ ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
      return send(200, list);
    }
    return notFound(res);
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    return handleContents(res, repo, repoPath, method, path, query, body);
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const name = bodyString(body, 'name');
      if (name === undefined || name === '') return send(422, { message: 'Validation Failed: name is required' });
      const existing = repo.labels.get(name);
      if (existing !== undefined) return send(201, labelJson(existing));
      const label: LabelRec = { name, color: bodyString(body, 'color') ?? 'ededed' };
      repo.labels.set(name, label);
      return send(201, labelJson(label));
    }
    if (method === 'GET' && rest.length === 1) return send(200, [...repo.labels.values()].map(labelJson));
    return notFound(res);
  }

  // Issues and comments.
  if (rest[0] === 'issues') {
    return handleIssues(res, repo, method, rest.slice(1), query, body);
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    return handlePulls(res, repo, method, rest.slice(1), query, body);
  }

  return notFound(res);
}

function handleContents(
  res: ServerResponse,
  repo: Repo,
  repoPath: string,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
): void {
  const send = (status: number, value: unknown): void => sendJson(res, status, value);
  void repoPath;

  if (method === 'GET') {
    const commitOid = resolveCommitRef(repo, query.get('ref') ?? undefined);
    if (commitOid === null) return send(404, { message: 'Not Found' });
    const flat = flatTreeOfCommit(repo, commitOid);
    if (path === '') {
      const entries: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      for (const [entryPath, entry] of flat) {
        const first = entryPath.split('/')[0] as string;
        if (seen.has(first)) continue;
        seen.add(first);
        const isDir = entryPath.includes('/');
        entries.push({ type: isDir ? 'dir' : 'file', name: first, path: first, sha: isDir ? entry.oid : entry.oid, size: 0 });
      }
      return send(200, entries);
    }
    const entry = flat.get(path);
    if (entry !== undefined) {
      const blob = repo.objects.get(entry.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      return send(200, {
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        sha: entry.oid,
        size: data.length,
        name: path.split('/').pop(),
        path,
      });
    }
    // A directory: list its immediate entries.
    const prefix = `${path}/`;
    const children = new Map<string, { type: string; sha: string }>();
    for (const [entryPath, entryEntry] of flat) {
      if (!entryPath.startsWith(prefix)) continue;
      const remainder = entryPath.slice(prefix.length);
      const first = remainder.split('/')[0] as string;
      if (!children.has(first)) {
        children.set(first, { type: remainder.includes('/') ? 'dir' : 'file', sha: entryEntry.oid });
      }
    }
    if (children.size === 0) return send(404, { message: 'Not Found' });
    const listing: Array<Record<string, unknown>> = [];
    for (const [name, child] of children) {
      listing.push({ type: child.type, name, path: `${prefix}${name}`, sha: child.sha, size: 0 });
    }
    listing.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return send(200, listing);
  }

  if (method === 'PUT') {
    const message = bodyString(body, 'message') ?? 'Update file';
    const contentB64 = bodyString(body, 'content');
    if (contentB64 === undefined) return send(422, { message: 'Validation Failed: content is required' });
    const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    if (tip === undefined) {
      // A write to a missing branch starts it from the default branch tip (or from empty).
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    const flat = new Map<string, { mode: string; oid: string }>();
    if (tip !== undefined) {
      for (const [entryPath, entry] of flatTreeOfCommit(repo, tip)) flat.set(entryPath, { mode: entry.mode, oid: entry.oid });
      if (repo.refs.get(ref) === undefined) repo.refs.set(ref, tip);
    }
    const existing = flat.get(path);
    const givenSha = bodyString(body, 'sha')?.toLowerCase();
    if (existing !== undefined && givenSha !== undefined && givenSha !== existing.oid) {
      return send(409, { message: `Conflict: the file sha ${givenSha} does not match the current sha` });
    }
    const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const blobOid = putObject(repo, 'blob', data);
    flat.set(path, { mode: '100644', oid: blobOid });
    const commitSha = commitFlatTree(repo, branch, flat, message);
    const created = existing === undefined;
    return send(created ? 201 : 200, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
  }

  if (method === 'DELETE') {
    const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return send(404, { message: 'Not Found' });
    const flat = new Map<string, { mode: string; oid: string }>();
    for (const [entryPath, entry] of flatTreeOfCommit(repo, tip)) flat.set(entryPath, { mode: entry.mode, oid: entry.oid });
    const existing = flat.get(path);
    if (existing === undefined) return send(404, { message: 'Not Found' });
    const givenSha = bodyString(body, 'sha')?.toLowerCase();
    if (givenSha !== undefined && givenSha !== existing.oid) {
      return send(409, { message: 'Conflict: sha does not match' });
    }
    flat.delete(path);
    const commitSha = commitFlatTree(repo, branch, flat, bodyString(body, 'message') ?? 'Delete file');
    return send(200, { content: null, commit: { sha: commitSha } });
  }

  return notFound(res);
}

function handleIssues(
  res: ServerResponse,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
): void {
  const send = (status: number, value: unknown): void => sendJson(res, status, value);

  if (rest.length === 0) {
    if (method === 'POST') {
      const title = bodyString(body, 'title');
      if (title === undefined) return send(422, { message: 'Validation Failed: title is required' });
      const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return send(422, { message: `Validation Failed: label "${label}" does not exist` });
      }
      const issue = createIssueRecord(repo, title, bodyString(body, 'body') ?? '', labels);
      return send(201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? (query.get('sort') ? 'desc' : 'asc');
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      list = list.slice((page - 1) * perPage, page * perPage);
      return send(200, list.map((issue) => issueJson(repo, issue)));
    }
    return notFound(res);
  }

  const number = Number(rest[0]);
  const issue = Number.isSafeInteger(number) ? repo.issues.get(number) : undefined;

  if (rest.length === 1) {
    if (issue === undefined) return send(404, { message: 'Not Found' });
    if (method === 'GET') return send(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      const state = bodyString(body, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = bodyString(body, 'title');
      if (title !== undefined) issue.title = title;
      const text = bodyString(body, 'body');
      if (text !== undefined) issue.body = text;
      const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : undefined;
      if (labels !== undefined) {
        for (const label of labels) {
          if (!repo.labels.has(label)) return send(422, { message: `Validation Failed: label "${label}" does not exist` });
        }
        issue.labels = labels;
      }
      issue.updatedAt = nextStamp();
      return send(200, issueJson(repo, issue));
    }
    return notFound(res);
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return send(404, { message: 'Not Found' });
    if (method === 'POST') {
      const text = bodyString(body, 'body');
      if (text === undefined) return send(422, { message: 'Validation Failed: body is required' });
      const comment: CommentRec = { gid: nextGid, body: text, createdAt: nextStamp() };
      nextGid += 1;
      issue.comments.push(comment);
      return send(201, commentJson(comment));
    }
    if (method === 'GET') return send(200, issue.comments.map(commentJson));
    return notFound(res);
  }

  return notFound(res);
}

function handlePulls(
  res: ServerResponse,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
): void {
  const send = (status: number, value: unknown): void => sendJson(res, status, value);

  if (rest.length === 0) {
    if (method === 'POST') {
      const title = bodyString(body, 'title') ?? '';
      const head = (bodyString(body, 'head') ?? '').split(':').pop() as string;
      const base = (bodyString(body, 'base') ?? repo.defaultBranch).split(':').pop() as string;
      if (head === '' || repo.refs.get(`refs/heads/${head}`) === undefined) {
        return send(422, { message: `Validation Failed: head branch "${head}" does not exist` });
      }
      if (repo.refs.get(`refs/heads/${base}`) === undefined) {
        return send(422, { message: `Validation Failed: base branch "${base}" does not exist` });
      }
      const pull = createPullRecord(repo, title, bodyString(body, 'body') ?? '', head, base);
      if (pull === null) return send(422, { message: 'Validation Failed: could not create the pull request' });
      return send(201, pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      list = list.slice((page - 1) * perPage, page * perPage);
      return send(200, list.map((pull) => pullJson(repo, pull)));
    }
    return notFound(res);
  }

  const number = Number(rest[0]);
  const pull = Number.isSafeInteger(number) ? repo.pulls.get(number) : undefined;

  if (rest.length === 1) {
    if (pull === undefined) return send(404, { message: 'Not Found' });
    if (method === 'GET') return send(200, pullJson(repo, pull));
    if (method === 'PATCH') {
      const state = bodyString(body, 'state');
      if ((state === 'open' || state === 'closed') && !pull.merged) pull.state = state;
      const title = bodyString(body, 'title');
      if (title !== undefined) pull.title = title;
      const text = bodyString(body, 'body');
      if (text !== undefined) pull.body = text;
      pull.updatedAt = nextStamp();
      return send(200, pullJson(repo, pull));
    }
    return notFound(res);
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (pull === undefined) return send(404, { message: 'Not Found' });
    const files = pullFiles(repo, pull).map((change) => ({
      sha: '',
      filename: change.path,
      status: change.status === 'removed' ? 'removed' : change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
    }));
    return send(200, files);
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return send(404, { message: 'Not Found' });
    const outcome = mergePullRecord(repo, pull);
    if (!outcome.ok) {
      if (outcome.conflict) return send(405, { message: 'Pull Request is not mergeable: merge conflict' });
      return send(405, { message: 'Pull Request is not mergeable' });
    }
    return send(200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return notFound(res);
}

// ------------------------------------------------------------------ git smart HTTP

const CAP_AGENT = 'agent=makefun-forge/1.0';
const GIT_V2_CAPS = ['version 2', CAP_AGENT, 'fetch=shallow wait-for-done', 'ls-refs=unborn', 'object-format=sha1'];
const GIT_V0_BASE_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

function gitV0Caps(repo: Repo): string {
  return `${GIT_V0_BASE_CAPS} symref=HEAD:refs/heads/${repo.defaultBranch}`;
}

interface RefAdvertisement {
  ref: string;
  oid: string;
  peeled?: string;
}

/** HEAD (when it points at an existing ref) followed by refs in stable order. */
function advertisedRefs(repo: Repo, includeHead: boolean): RefAdvertisement[] {
  const out: RefAdvertisement[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (includeHead && headOid !== undefined) out.push({ ref: 'HEAD', oid: headOid });
  const names = [...repo.refs.keys()].sort();
  for (const ref of names) {
    const oid = repo.refs.get(ref) as string;
    out.push({ ref, oid });
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== oid && repo.objects.get(peeled)?.type === 'commit') out.push({ ref: `${ref}^{}`, oid: peeled });
    }
  }
  return out;
}

function handleGitInfoRefs(res: ServerResponse, repo: Repo, query: URLSearchParams, protocolVersion: string): void {
  const service = query.get('service');
  const wantsV2 = protocolVersion === '2' || protocolVersion === 'version=2';
  const parts: Buffer[] = [];
  if (wantsV2) {
    parts.push(pktLine('# service=git-upload-pack\n'));
    parts.push(PKT_FLUSH);
    for (const cap of GIT_V2_CAPS) parts.push(pktLine(`${cap}\n`));
    parts.push(PKT_FLUSH);
  } else if (service === 'git-receive-pack') {
    parts.push(pktLine('# service=git-receive-pack\n'));
    parts.push(PKT_FLUSH);
    const refs = advertisedRefs(repo, false);
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${gitV0Caps(repo)}\n`));
    } else {
      refs.forEach((entry, index) => {
        const suffix = index === 0 ? `\0${gitV0Caps(repo)}` : '';
        parts.push(pktLine(`${entry.oid} ${entry.ref}${suffix}\n`));
      });
    }
    parts.push(PKT_FLUSH);
  } else {
    parts.push(pktLine('# service=git-upload-pack\n'));
    parts.push(PKT_FLUSH);
    const refs = advertisedRefs(repo, true);
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${gitV0Caps(repo)}\n`));
    } else {
      refs.forEach((entry, index) => {
        const suffix = index === 0 ? `\0${gitV0Caps(repo)}` : '';
        parts.push(pktLine(`${entry.oid} ${entry.ref}${suffix}\n`));
      });
    }
    parts.push(PKT_FLUSH);
  }
  const contentType = service === 'git-receive-pack' ? 'application/x-git-receive-pack-advertisement' : 'application/x-git-upload-pack-advertisement';
  sendBuffer(res, 200, Buffer.concat(parts), contentType);
}

interface LsRefsArgs {
  prefixes: string[];
  peel: boolean;
  unborn: boolean;
}

function lsRefsReply(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const matches = (ref: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => ref === p || ref.startsWith(`${p}/`) || ref.startsWith(p));
  if (matches('HEAD')) {
    const headOid = repo.refs.get(headRef);
    if (headOid !== undefined) parts.push(pktLine(`${headOid} HEAD symref-target:${headRef}\n`));
    else if (args.unborn) parts.push(pktLine(`unborn HEAD symref-target:${headRef}\n`));
  }
  const names = [...repo.refs.keys()].sort();
  for (const ref of names) {
    if (!matches(ref)) continue;
    const oid = repo.refs.get(ref) as string;
    let suffix = '';
    if (args.peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled !== oid) suffix = ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${oid} ${ref}${suffix}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowHeld: string[];
  deepen: number;
  deepenSince: number | null;
  deepenNot: string[];
  shallowSince: number | null;
  deepenRelative: boolean;
  done: boolean;
  sidebandAll: boolean;
  filter: boolean;
}

function parseFetchLines(lines: string[]): FetchRequest {
  const parsed: FetchRequest = {
    wants: [],
    haves: [],
    shallowHeld: [],
    deepen: 0,
    deepenSince: null,
    deepenNot: [],
    shallowSince: null,
    deepenRelative: false,
    done: false,
    sidebandAll: false,
    filter: false,
  };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\n$/, '');
    const [command, ...rest] = line.split(' ');
    const arg = rest.join(' ');
    if (command === 'want') parsed.wants.push(arg.toLowerCase());
    else if (command === 'have') parsed.haves.push(arg.toLowerCase());
    else if (command === 'shallow') parsed.shallowHeld.push(arg.toLowerCase());
    else if (command === 'deepen') parsed.deepen = Number(arg) || 0;
    else if (command === 'deepen-since') parsed.deepenSince = Number(arg) || 0;
    else if (command === 'deepen-not') parsed.deepenNot.push(arg);
    else if (command === 'shallow-since') parsed.shallowSince = Number(arg) || 0;
    else if (command === 'deepen-relative') parsed.deepenRelative = true;
    else if (command === 'done') parsed.done = true;
    else if (command === 'sideband-all') parsed.sidebandAll = true;
    else if (command === 'filter') parsed.filter = true;
  }
  return parsed;
}

/** Commits whose depth from any want tip is <= depth; shallow = included commits with an excluded parent. */
function depthLimitedCommits(repo: Repo, wants: readonly string[], depth: number): { included: Set<string>; shallow: Set<string> } {
  const included = new Set<string>();
  let frontier = wants.filter((oid) => repo.objects.get(oid)?.type === 'commit');
  let level = 0;
  while (frontier.length > 0) {
    level += 1;
    const next: string[] = [];
    for (const oid of frontier) {
      if (included.has(oid)) continue;
      included.add(oid);
      if (level < depth) {
        const commit = getCommit(repo, oid);
        if (commit !== null) {
          for (const parent of commit.parents) {
            if (repo.objects.get(parent)?.type === 'commit') next.push(parent);
          }
        }
      }
    }
    frontier = next;
  }
  const shallow = new Set<string>();
  for (const oid of included) {
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    if (commit.parents.some((parent) => !included.has(parent))) shallow.add(oid);
  }
  return { included, shallow };
}

function packForFetch(repo: Repo, request: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const haveSet = new Set(request.haves.filter((oid) => repo.objects.has(oid)));
  // Everything reachable from the haves is already held by the client: never re-send it.
  // Commits the client names as shallow bound that closure: their parents are not held.
  const haveClosure = reachable(repo, haveSet, new Set(request.shallowHeld));
  if (request.deepen > 0) {
    const { included, shallow } = depthLimitedCommits(repo, request.wants, request.deepen);
    const send = new Set<string>();
    for (const oid of included) {
      if (!haveClosure.has(oid)) send.add(oid);
      const commit = getCommit(repo, oid);
      if (commit !== null) {
        for (const sub of reachable(repo, [commit.tree])) if (!haveClosure.has(sub)) send.add(sub);
      }
    }
    for (const want of request.wants) {
      const object = repo.objects.get(want);
      if (object !== undefined && object.type !== 'commit') {
        for (const sub of reachable(repo, [want])) if (!haveClosure.has(sub)) send.add(sub);
      }
    }
    const objects: GitObject[] = [];
    for (const oid of send) {
      const object = repo.objects.get(oid);
      if (object !== undefined) objects.push(object);
    }
    const unshallow = [...haveSet].filter((oid) => included.has(oid) && !shallow.has(oid));
    return { pack: writePack(objects), shallow: [...shallow], unshallow };
  }
  const sendSet = reachable(repo, request.wants, haveSet);
  const objects: GitObject[] = [];
  for (const oid of sendSet) {
    if (haveClosure.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { pack: writePack(objects), shallow: [], unshallow: [] };
}

function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

function handleUploadPack(res: ServerResponse, repo: Repo, body: Buffer, protocolVersion: string): void {
  const wantsV2 = protocolVersion === '2' || protocolVersion === 'version=2';
  let decoded: { packets: PktPacket[]; rest: Buffer };
  try {
    decoded = decodePktLines(body);
  } catch {
    return sendJson(res, 400, { message: 'Bad Request: malformed pkt-line stream' });
  }
  const lines: string[] = [];
  const commands: string[] = [];
  let section: 'command' | 'request' = wantsV2 ? 'command' : 'request';
  for (const packet of decoded.packets) {
    if (packet.kind === 'delim') {
      section = 'request';
      continue;
    }
    if (packet.kind === 'flush') break;
    const text = packet.payload.toString('utf8');
    if (section === 'command') commands.push(text.replace(/\n$/, ''));
    else lines.push(text);
  }

  if (wantsV2) {
    const command = commands.find((line) => line.startsWith('command='));
    if (command === 'command=ls-refs') {
      const args: LsRefsArgs = { prefixes: [], peel: false, unborn: false };
      for (const line of lines) {
        const clean = line.replace(/\n$/, '');
        if (clean.startsWith('ref-prefix ')) args.prefixes.push(clean.slice('ref-prefix '.length));
        else if (clean === 'peel') args.peel = true;
        else if (clean === 'unborn') args.unborn = true;
      }
      return sendBuffer(res, 200, lsRefsReply(repo, args), 'application/x-git-upload-pack-result');
    }
    if (command === 'command=fetch') {
      const request = parseFetchLines(lines);
      if (!request.done) {
        return sendBuffer(res, 200, pktLine('acknowledgments\nready\n'), 'application/x-git-upload-pack-result');
      }
      const { pack, shallow, unshallow } = packForFetch(repo, request);
      const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH];
      if (shallow.length > 0 || unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
        for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
        parts.push(PKT_FLUSH);
      }
      parts.push(pktLine('packfile\n'));
      parts.push(sidebandPack(pack));
      return sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    }
    return sendJson(res, 400, { message: 'Bad Request: unknown git command' });
  }

  // Protocol v0 fetch: wants/haves lines, then NAK + sideband pack.
  const request = parseFetchLines(lines);
  if (request.wants.length === 0) return sendJson(res, 400, { message: 'Bad Request: no wants' });
  const { pack } = packForFetch(repo, request);
  const parts: Buffer[] = [pktLine('NAK\n'), sidebandPack(pack)];
  return sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(res: ServerResponse, repo: Repo, body: Buffer): void {
  let decoded: { packets: PktPacket[]; rest: Buffer };
  try {
    decoded = decodePktLines(body);
  } catch {
    return sendJson(res, 400, { message: 'Bad Request: malformed pkt-line stream' });
  }
  const updates: RefUpdate[] = [];
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') break;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const fields = text.split(' ');
    if (fields.length !== 3) continue;
    updates.push({ oldOid: (fields[0] as string).toLowerCase(), newOid: (fields[1] as string).toLowerCase(), ref: fields[2] as string });
  }
  const packBytes = decoded.rest;

  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const object of objects) putObject(repo, object.type, object.data);
    } catch {
      return sendJson(res, 400, { message: 'Bad Request: malformed packfile' });
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const update of updates) {
    const current = repo.refs.get(update.ref) ?? ZERO_OID;
    if (update.newOid === ZERO_OID) {
      repo.refs.delete(update.ref);
      results.push({ ref: update.ref, ok: true });
      continue;
    }
    const object = repo.objects.get(update.newOid);
    if (object === undefined) {
      results.push({ ref: update.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (current !== ZERO_OID && object.type === 'commit') {
      const oldObject = repo.objects.get(current);
      if (oldObject !== undefined && oldObject.type === 'commit' && !isAncestor(repo, current, update.newOid)) {
        results.push({ ref: update.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(update.ref, update.newOid);
    results.push({ ref: update.ref, ok: true });
  }
  repo.updatedAt = nextStamp();

  const reportLines: string[] = ['unpack ok\n'];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'rejected'}\n`);
  }
  const report = Buffer.concat(reportLines.map((line) => pktLine(line)));
  const wrapped = pktLine(Buffer.concat([Buffer.from([1]), report]));
  sendBuffer(res, 200, Buffer.concat([wrapped, PKT_FLUSH]), 'application/x-git-receive-pack-result');
}

// ------------------------------------------------------------------ GraphQL

interface GqlToken {
  kind: 'name' | 'string' | 'number' | 'punct' | 'eof';
  value: string;
}

function gqlTokenize(source: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const escaped = source[j + 1] as string;
          if (escaped === 'n') value += '\n';
          else if (escaped === 't') value += '\t';
          else if (escaped === 'r') value += '\r';
          else if (escaped === 'u') {
            value += String.fromCodePoint(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += escaped;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

interface GqlValue {
  kind: 'string' | 'number' | 'boolean' | 'null' | 'enum' | 'variable' | 'list' | 'object';
  value?: unknown;
  items?: GqlValue[];
  fields?: Array<[string, GqlValue]>;
}

interface GqlField {
  name: string;
  alias?: string;
  args: Array<[string, GqlValue]>;
  selections: GqlField[];
  typeCondition?: string;
  spread?: string;
}

interface GqlOperation {
  type: 'query' | 'mutation';
  name?: string;
  variables: Record<string, unknown>;
  selections: GqlField[];
}

class GqlParser {
  private tokens: GqlToken[];
  private pos = 0;
  readonly fragments = new Map<string, { typeCondition: string; selections: GqlField[] }>();

  constructor(source: string) {
    this.tokens = gqlTokenize(source);
  }

  private peek(): GqlToken {
    return this.tokens[this.pos] as GqlToken;
  }

  private next(): GqlToken {
    const token = this.tokens[this.pos] as GqlToken;
    this.pos += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private skipDirectivesAndTypes(): void {
    // Skip variable definitions "(...)" and directives "@name(...)" loosely.
    for (;;) {
      const token = this.peek();
      if (token.value === '(') {
        let depth = 0;
        do {
          const t = this.next();
          if (t.value === '(') depth += 1;
          else if (t.value === ')') depth -= 1;
          else if (t.kind === 'eof') throw new Error('unterminated parenthesised block');
        } while (depth > 0);
        continue;
      }
      if (token.value === '@') {
        this.next();
        this.next();
        continue;
      }
      break;
    }
  }

  parseDocument(variables: Record<string, unknown>): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.value === '{') {
        operations.push({ type: 'query', variables, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        this.skipDirectivesAndTypes();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next(); // 'fragment'
        const fragName = this.next().value;
        this.next(); // 'on'
        const typeCondition = this.next().value;
        this.skipDirectivesAndTypes();
        const selections = this.parseSelectionSet();
        this.fragments.set(fragName, { typeCondition, selections });
        continue;
      }
      throw new Error(`unexpected token ${token.value}`);
    }
    for (const operation of operations) operation.selections = this.expandSpreads(operation.selections);
    return operations;
  }

  private expandSpreads(fields: GqlField[]): GqlField[] {
    const out: GqlField[] = [];
    for (const field of fields) {
      if (field.spread !== undefined) {
        const fragment = this.fragments.get(field.spread);
        if (fragment !== undefined) {
          for (const inner of this.expandSpreads(fragment.selections)) {
            out.push({ ...inner, typeCondition: inner.typeCondition ?? fragment.typeCondition });
          }
        }
        continue;
      }
      out.push({ ...field, selections: this.expandSpreads(field.selections) });
    }
    return out;
  }

  private parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      if (this.peek().value === '...') {
        this.next();
        const next = this.peek();
        if (next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          this.skipDirectivesAndTypes();
          const inner = this.parseSelectionSet();
          for (const field of inner) fields.push({ ...field, typeCondition: field.typeCondition ?? typeCondition });
          continue;
        }
        const spreadName = this.next().value;
        this.skipDirectivesAndTypes();
        fields.push({ name: '', args: [], selections: [], spread: spreadName });
        continue;
      }
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): GqlField {
    const first = this.next();
    if (first.kind !== 'name') throw new Error(`expected a field name, got ${first.value}`);
    let alias: string | undefined;
    let name = first.value;
    if (this.peek().value === ':') {
      this.next();
      alias = name;
      name = (this.next().value as string) ?? '';
    }
    const args: Array<[string, GqlValue]> = [];
    if (this.peek().value === '(') {
      this.next();
      while (this.peek().value !== ')') {
        const argName = this.next().value;
        this.expect(':');
        args.push([argName, this.parseValue()]);
      }
      this.expect(')');
    }
    this.skipDirectivesAndTypes();
    let selections: GqlField[] = [];
    if (this.peek().value === '{') selections = this.parseSelectionSet();
    return { name, alias, args, selections };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.value === '$') {
      const name = this.next().value;
      return { kind: 'variable', value: name };
    }
    if (token.value === '[') {
      const items: GqlValue[] = [];
      while (this.peek().value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.value === '{') {
      const fields: Array<[string, GqlValue]> = [];
      while (this.peek().value !== '}') {
        const key = this.next().value;
        this.expect(':');
        fields.push([key, this.parseValue()]);
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function gqlResolve(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'variable':
      return variables[String(value.value)];
    case 'list':
      return (value.items ?? []).map((item) => gqlResolve(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields ?? []) out[key] = gqlResolve(item, variables);
      return out;
    }
  }
}

function gqlArgs(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = gqlResolve(value, variables);
  return out;
}

// ------------------------------------------------------------------ GraphQL execution

type GqlNode = { __node: true; t: string } & Record<string, unknown>;

function node(t: string, extra: Record<string, unknown> = {}): GqlNode {
  return { __node: true, t, ...extra };
}

function isNode(value: unknown): value is GqlNode {
  return isRecord(value) && value.__node === true;
}

class FieldError extends Error {}

interface GqlCtx {
  errors: Array<{ message: string }>;
  vars: Record<string, unknown>;
}

const TYPE_KINDS: Readonly<Record<string, string>> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  User: 'OBJECT',
  Repository: 'OBJECT',
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  IssueComment: 'OBJECT',
  Label: 'OBJECT',
  Ref: 'OBJECT',
  Commit: 'OBJECT',
  PageInfo: 'OBJECT',
  SearchResultItemConnection: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  RepositoryConnection: 'OBJECT',
  LabelConnection: 'OBJECT',
  RefConnection: 'OBJECT',
  IssueCommentConnection: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT',
  PullRequestCommitConnection: 'OBJECT',
  CreateIssuePayload: 'OBJECT',
  CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  SearchType: 'ENUM',
  MergeableState: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  String: 'SCALAR',
  Int: 'SCALAR',
  Float: 'SCALAR',
  Boolean: 'SCALAR',
  ID: 'SCALAR',
  URI: 'SCALAR',
  DateTime: 'SCALAR',
  GitObjectID: 'SCALAR',
};

const ENUM_VALUES: Readonly<Record<string, string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const TYPE_FIELDS: Readonly<Record<string, Array<[string, string]>>> = {
  Issue: [
    ['id', 'ID'], ['databaseId', 'Int'], ['number', 'Int'], ['title', 'String'], ['body', 'String'], ['bodyText', 'String'], ['state', 'IssueState'],
    ['url', 'URI'], ['author', 'User'], ['labels', 'LabelConnection'], ['comments', 'IssueCommentConnection'],
    ['repository', 'Repository'], ['createdAt', 'DateTime'], ['updatedAt', 'DateTime'], ['closedAt', 'DateTime'],
  ],
  PullRequest: [
    ['id', 'ID'], ['databaseId', 'Int'], ['number', 'Int'], ['title', 'String'], ['body', 'String'], ['state', 'PullRequestState'],
    ['merged', 'Boolean'], ['mergedAt', 'DateTime'], ['mergeCommit', 'Commit'], ['headRefName', 'String'],
    ['baseRefName', 'String'], ['headRefOid', 'GitObjectID'], ['baseRefOid', 'GitObjectID'],
    ['mergeable', 'MergeableState'], ['files', 'PullRequestChangedFileConnection'],
    ['additions', 'Int'], ['deletions', 'Int'], ['changedFiles', 'Int'], ['commits', 'PullRequestCommitConnection'],
    ['url', 'URI'], ['author', 'User'], ['repository', 'Repository'],
    ['createdAt', 'DateTime'], ['updatedAt', 'DateTime'], ['closedAt', 'DateTime'],
  ],
  Repository: [
    ['id', 'ID'], ['databaseId', 'Int'], ['name', 'String'], ['nameWithOwner', 'String'], ['description', 'String'],
    ['isPrivate', 'Boolean'], ['owner', 'User'], ['defaultBranchRef', 'Ref'], ['issues', 'IssueConnection'],
    ['pullRequests', 'PullRequestConnection'], ['issue', 'Issue'], ['pullRequest', 'PullRequest'],
    ['labels', 'LabelConnection'], ['url', 'URI'], ['createdAt', 'DateTime'], ['updatedAt', 'DateTime'],
    ['viewerPermission', 'String'], ['hasIssuesEnabled', 'Boolean'],
  ],
  User: [['id', 'ID'], ['login', 'String'], ['name', 'String'], ['email', 'String'], ['url', 'URI'], ['repositories', 'RepositoryConnection']],
  Query: [['viewer', 'User'], ['repository', 'Repository'], ['node', 'Node'], ['search', 'SearchResultItemConnection']],
  Mutation: [['createIssue', 'CreateIssuePayload'], ['closeIssue', 'CloseIssuePayload'], ['createPullRequest', 'CreatePullRequestPayload'], ['mergePullRequest', 'MergePullRequestPayload'], ['addComment', 'AddCommentPayload']],
};

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function cursorIndex(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface Page<T> {
  items: T[];
  total: number;
  startIndex: number;
  hasNext: boolean;
  hasPrev: boolean;
}

function paginate<T>(all: readonly T[], args: Record<string, unknown>): Page<T> {
  let start = 0;
  let end = all.length;
  const after = cursorIndex(args.after);
  if (after !== null) start = Math.max(start, after + 1);
  const before = cursorIndex(args.before);
  if (before !== null) end = Math.min(end, before);
  let slice = all.slice(start, end);
  let sliceStart = start;
  if (typeof args.first === 'number') slice = slice.slice(0, Math.max(0, args.first));
  if (typeof args.last === 'number') {
    const keep = Math.max(0, args.last);
    sliceStart += Math.max(0, slice.length - keep);
    slice = slice.slice(slice.length - keep);
  }
  return {
    items: slice,
    total: all.length,
    startIndex: sliceStart,
    hasNext: sliceStart + slice.length < all.length,
    hasPrev: sliceStart > 0,
  };
}

function connectionNode(type: string, all: readonly GqlNode[], args: Record<string, unknown>): GqlNode {
  const page = paginate(all, args);
  return node(type, {
    pageItems: page.items,
    pageStart: page.startIndex,
    pageTotal: page.total,
    pageHasNext: page.hasNext,
    pageHasPrev: page.hasPrev,
  });
}

function execNode(current: GqlNode, selections: readonly GqlField[], ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    const key = field.alias ?? field.name;
    if (field.typeCondition !== undefined && field.typeCondition !== current.t && field.typeCondition !== 'Node') continue;
    if (field.name === '__typename') {
      out[key] = current.t;
      continue;
    }
    try {
      const value = resolveField(current, field, ctx);
      out[key] = materialize(value, field, ctx);
    } catch (error) {
      if (error instanceof FieldError) {
        ctx.errors.push({ message: error.message });
        out[key] = null;
      } else {
        throw error;
      }
    }
  }
  return out;
}

function materialize(value: unknown, field: GqlField, ctx: GqlCtx): unknown {
  if (isNode(value)) return execNode(value, field.selections, ctx);
  if (Array.isArray(value)) return value.map((item) => (isNode(item) ? execNode(item, field.selections, ctx) : item));
  return value;
}

function findIssueByGid(gid: number): { repo: Repo; issue: IssueRec } | null {
  for (const repo of repos.values()) {
    for (const issue of repo.issues.values()) if (issue.gid === gid) return { repo, issue };
  }
  return null;
}

function findPullByGid(gid: number): { repo: Repo; pull: PullRec } | null {
  for (const repo of repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.gid === gid) return { repo, pull };
  }
  return null;
}

function findRepoById(id: number): Repo | null {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return null;
}

function unknownField(current: GqlNode, name: string): FieldError {
  return new FieldError(`Field '${name}' doesn't exist on type '${current.t}'`);
}

function userNode(): GqlNode {
  return node('User', {});
}

function issueNode(repo: Repo, issue: IssueRec): GqlNode {
  return node('Issue', { repo, issue });
}

function pullNode(repo: Repo, pull: PullRec): GqlNode {
  return node('PullRequest', { repo, pull });
}

function resolveField(current: GqlNode, field: GqlField, ctx: GqlCtx): unknown {
  const args = gqlArgs(field, ctx.vars);
  const name = field.name;

  // Introspection types resolve generically.
  if (current.t === '__Type') return resolveTypeField(current, name, args, field);
  if (current.t === '__Field') {
    if (name === 'name') return current.fieldName;
    if (name === 'description') return null;
    if (name === 'args') return (current.fieldArgs as Array<[string, string]>).map(([n, t]) => node('__InputValue', { inputName: n, inputType: t }));
    if (name === 'type') return node('__Type', { typeName: current.fieldType });
    if (name === 'isDeprecated') return false;
    if (name === 'deprecationReason') return null;
    throw unknownField(current, name);
  }
  if (current.t === '__InputValue') {
    if (name === 'name') return current.inputName;
    if (name === 'description') return null;
    if (name === 'type') return node('__Type', { typeName: current.inputType });
    if (name === 'defaultValue') return null;
    throw unknownField(current, name);
  }
  if (current.t === '__EnumValue') {
    if (name === 'name') return current.enumName;
    if (name === 'description') return null;
    if (name === 'isDeprecated') return false;
    if (name === 'deprecationReason') return null;
    throw unknownField(current, name);
  }
  if (current.t === '__Schema') {
    if (name === 'types') return Object.keys(TYPE_KINDS).map((typeName) => node('__Type', { typeName }));
    if (name === 'queryType') return node('__Type', { typeName: 'Query' });
    if (name === 'mutationType') return node('__Type', { typeName: 'Mutation' });
    if (name === 'subscriptionType') return null;
    if (name === 'directives') return [];
    throw unknownField(current, name);
  }

  // Connections resolve generically from their page window.
  if (current.t.endsWith('Connection')) return resolveConnectionField(current, name, field, ctx);

  if (current.t === 'Edge') {
    if (name === 'node') return current.edgeNode;
    if (name === 'cursor') return current.edgeCursor;
    throw unknownField(current, name);
  }

  if (current.t === 'PageInfo') {    if (name === 'hasNextPage') return current.hasNextPage;
    if (name === 'hasPreviousPage') return current.hasPreviousPage;
    if (name === 'startCursor') return current.startCursor;
    if (name === 'endCursor') return current.endCursor;
    throw unknownField(current, name);
  }

  switch (current.t) {
    case 'Query':
      return resolveQueryField(name, args);
    case 'Mutation':
      return resolveMutationField(name, args);
    case 'User':
      return resolveUserField(current, name, args);
    case 'Repository':
      return resolveRepoField(current, name, args);
    case 'Issue':
      return resolveIssueField(current, name, args);
    case 'PullRequest':
      return resolvePullField(current, name, args);
    case 'IssueComment': {
      const comment = current.comment as CommentRec;
      if (name === 'id') return globalId('IssueComment', comment.gid);
      if (name === 'body') return comment.body;
      if (name === 'author') return userNode();
      if (name === 'createdAt' || name === 'updatedAt') return comment.createdAt;
      if (name === 'url') return '';
      throw unknownField(current, name);
    }
    case 'Label': {
      const label = current.label as LabelRec;
      if (name === 'id') return globalId('Label', 0);
      if (name === 'name') return label.name;
      if (name === 'color') return label.color;
      if (name === 'description') return null;
      throw unknownField(current, name);
    }
    case 'Ref': {
      if (name === 'name') return current.refName;
      if (name === 'prefix') return 'refs/heads/';
      if (name === 'qualifiedName') return `refs/heads/${current.refName as string}`;
      if (name === 'target') return node('Commit', { repo: current.repo, oid: current.oid });
      if (name === 'repository') return node('Repository', { repo: current.repo });
      throw unknownField(current, name);
    }
    case 'Commit': {
      const repo = current.repo as Repo;
      const oid = current.oid as string;
      const commit = getCommit(repo, oid);
      if (name === 'id') return globalId('Commit', 0);
      if (name === 'oid') return oid;
      if (name === 'message') return commit?.message ?? '';
      if (name === 'messageHeadline') return (commit?.message ?? '').split('\n')[0] ?? '';
      if (name === 'messageBody') return (commit?.message ?? '').split('\n').slice(2).join('\n');
      if (name === 'committedDate' || name === 'authoredDate') return new Date(EPOCH_BASE * 1000).toISOString();
      if (name === 'author') return { name: 'Forge', email: 'forge@example.invalid' };
      if (name === 'tree') return { oid: commit?.tree ?? ZERO_OID };
      if (name === 'url') return '';
      throw unknownField(current, name);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return issueNode(current.repo as Repo, current.issue as IssueRec);
      if (name === 'clientMutationId') return current.clientMutationId ?? null;
      throw unknownField(current, name);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return pullNode(current.repo as Repo, current.pull as PullRec);
      if (name === 'clientMutationId') return current.clientMutationId ?? null;
      throw unknownField(current, name);
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') {
        const comment = current.comment as CommentRec;
        return node('Edge', { edgeNode: node('IssueComment', { comment }), edgeCursor: cursorOf(0) });
      }
      if (name === 'subject') return issueNode(current.repo as Repo, current.issue as IssueRec);
      if (name === 'clientMutationId') return current.clientMutationId ?? null;
      throw unknownField(current, name);
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return current.path;
      if (name === 'additions') return current.additions;
      if (name === 'deletions') return current.deletions;
      if (name === 'changeType') return String(current.status).toUpperCase() === 'REMOVED' ? 'DELETED' : String(current.status).toUpperCase();
      throw unknownField(current, name);
    }
    default:
      throw unknownField(current, name);
  }
}

function resolveTypeField(current: GqlNode, name: string, args: Record<string, unknown>, field: GqlField): unknown {
  void field;
  const typeName = current.typeName as string;
  const kind = TYPE_KINDS[typeName];
  if (kind === undefined) throw new FieldError(`Unknown type '${typeName}'`);
  if (name === 'name') return typeName;
  if (name === 'kind') return kind;
  if (name === 'description') return null;
  if (name === 'fields') {
    if (kind !== 'OBJECT') return null;
    return (TYPE_FIELDS[typeName] ?? []).map(([fieldName, fieldType]) => node('__Field', { fieldName, fieldType, fieldArgs: [] }));
  }
  if (name === 'enumValues') {
    if (kind !== 'ENUM') return null;
    void args;
    return (ENUM_VALUES[typeName] ?? []).map((enumName) => node('__EnumValue', { enumName }));
  }
  if (name === 'possibleTypes') return null;
  if (name === 'inputFields') return null;
  if (name === 'interfaces') return [];
  if (name === 'specifiedByURL' || name === 'specifiedByUrl') return null;
  if (name === 'isOneOf') return false;
  throw unknownField(current, name);
}

function resolveConnectionField(current: GqlNode, name: string, field: GqlField, ctx: GqlCtx): unknown {
  const items = current.pageItems as GqlNode[];
  const start = current.pageStart as number;
  if (name === 'totalCount' || name === 'issueCount' || name === 'repositoryCount' || name === 'userCount' || name === 'discussionCount' || name === 'codeCount') {
    return current.pageTotal;
  }
  if (name === 'nodes') return items;
  if (name === 'edges') {
    return items.map((item, i) => node('Edge', { edgeNode: item, edgeCursor: cursorOf(start + i) }));
  }
  if (name === 'pageInfo') {
    return node('PageInfo', {
      hasNextPage: current.pageHasNext,
      hasPreviousPage: current.pageHasPrev,
      startCursor: items.length > 0 ? cursorOf(start) : null,
      endCursor: items.length > 0 ? cursorOf(start + items.length - 1) : null,
    });
  }
  void field;
  void ctx;
  throw unknownField(current, name);
}

function resolveQueryField(name: string, args: Record<string, unknown>): unknown {
  if (name === 'viewer') return userNode();
  if (name === 'repository') {
    const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
    return repo === null ? null : node('Repository', { repo });
  }
  if (name === 'node') {
    const decoded = decodeGlobalId(String(args.id ?? ''));
    if (decoded === null) return null;
    if (decoded.type === 'Repository') {
      const repo = findRepoById(decoded.numericId);
      return repo === null ? null : node('Repository', { repo });
    }
    if (decoded.type === 'Issue') {
      const found = findIssueByGid(decoded.numericId);
      return found === null ? null : issueNode(found.repo, found.issue);
    }
    if (decoded.type === 'PullRequest') {
      const found = findPullByGid(decoded.numericId);
      return found === null ? null : pullNode(found.repo, found.pull);
    }
    if (decoded.type === 'User') return userNode();
    return null;
  }
  if (name === 'search') return searchNode(args);
  if (name === '__type') {
    const typeName = String(args.name ?? '');
    return TYPE_KINDS[typeName] === undefined ? null : node('__Type', { typeName });
  }
  if (name === '__schema') return node('__Schema', {});
  if (name === 'rateLimit') return { limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: new Date(EPOCH_BASE * 1000).toISOString(), nodeCount: 0 };
  throw new FieldError(`Field '${name}' doesn't exist on type 'Query'`);
}

function searchNode(args: Record<string, unknown>): GqlNode {
  const query = String(args.query ?? '');
  const type = String(args.type ?? 'ISSUE');
  const tokens = query.split(/\s+/).filter((token) => token !== '');
  let repoFilter: Repo | null = null;
  let wantPulls = false;
  let wantIssues = true;
  const textTerms: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('repo:')) {
      const [owner, repoName] = token.slice('repo:'.length).split('/');
      repoFilter = findRepo(owner ?? '', repoName ?? '');
    } else if (token === 'is:pr' || token === 'is:pull-request') {
      wantPulls = true;
      wantIssues = false;
    } else if (token === 'is:issue') {
      wantIssues = true;
    } else if (token.includes(':')) {
      continue;
    } else {
      textTerms.push(token.toLowerCase());
    }
  }
  const matches = (title: string): boolean => textTerms.every((term) => title.toLowerCase().includes(term));
  const items: GqlNode[] = [];
  const pool = repoFilter === null ? [...repos.values()] : [repoFilter];
  if (type === 'ISSUE' || type === 'REPOSITORY' || type === 'USER' || type === 'DISCUSSION') {
    for (const repo of pool) {
      if (wantIssues) {
        for (const issue of [...repo.issues.values()].sort((a, b) => a.number - b.number)) {
          if (matches(issue.title)) items.push(issueNode(repo, issue));
        }
      }
      if (wantPulls || type !== 'ISSUE') {
        for (const pull of [...repo.pulls.values()].sort((a, b) => a.number - b.number)) {
          if (matches(pull.title)) items.push(pullNode(repo, pull));
        }
      }
    }
  }
  return connectionNode('SearchResultItemConnection', items, args);
}

function resolveUserField(current: GqlNode, name: string, args: Record<string, unknown>): unknown {
  void current;
  if (name === 'id') return globalId('User', VIEWER_ID);
  if (name === 'login') return VIEWER_LOGIN;
  if (name === 'name') return VIEWER_NAME;
  if (name === 'email') return VIEWER_EMAIL;
  if (name === 'url') return `/${VIEWER_LOGIN}`;
  if (name === 'avatarUrl') return '';
  if (name === 'repositories') {
    const all = [...repos.values()].filter((repo) => repo.owner === VIEWER_LOGIN).sort((a, b) => a.id - b.id);
    return connectionNode('RepositoryConnection', all.map((repo) => node('Repository', { repo })), args);
  }
  if (name === 'repository') {
    const repo = findRepo(VIEWER_LOGIN, String(args.name ?? ''));
    return repo === null ? null : node('Repository', { repo });
  }
  throw new FieldError(`Field '${name}' doesn't exist on type 'User'`);
}

function stateFilter(values: unknown): Array<'open' | 'closed'> | null {
  if (!Array.isArray(values)) return null;
  const out: Array<'open' | 'closed'> = [];
  for (const value of values) {
    if (value === 'OPEN') out.push('open');
    else if (value === 'CLOSED') out.push('closed');
  }
  return out;
}

function resolveRepoField(current: GqlNode, name: string, args: Record<string, unknown>): unknown {
  const repo = current.repo as Repo;
  switch (name) {
    case 'id':
      return globalId('Repository', repo.id);
    case 'databaseId':
      return repo.id;
    case 'hasIssuesEnabled':
      return true;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'description':
      return repo.description === '' ? null : repo.description;
    case 'isPrivate':
      return repo.isPrivate;
    case 'owner':
      return userNode();
    case 'url':
      return `/${repo.owner}/${repo.name}`;
    case 'createdAt':
      return repo.createdAt;
    case 'updatedAt':
      return repo.updatedAt;
    case 'defaultBranchRef': {
      const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return oid === undefined ? null : node('Ref', { repo, refName: repo.defaultBranch, oid });
    }
    case 'ref': {
      const qualified = String(args.qualifiedName ?? '');
      const branch = qualified.startsWith('refs/heads/') ? qualified.slice('refs/heads/'.length) : qualified;
      const oid = repo.refs.get(`refs/heads/${branch}`);
      return oid === undefined ? null : node('Ref', { repo, refName: branch, oid });
    }
    case 'issues': {
      const states = stateFilter(args.states);
      let list = [...repo.issues.values()];
      if (states !== null) list = list.filter((issue) => states.includes(issue.state));
      const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
      const direction = orderBy.direction === 'DESC' ? 'DESC' : 'ASC';
      list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
      return connectionNode('IssueConnection', list.map((issue) => issueNode(repo, issue)), args);
    }
    case 'issue': {
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueNode(repo, issue);
    }
    case 'pullRequests': {
      const states = stateFilter(args.states);
      let list = [...repo.pulls.values()];
      if (states !== null) list = list.filter((pull) => (pull.merged ? false : states.includes(pull.state)));
      list.sort((a, b) => a.number - b.number);
      return connectionNode('PullRequestConnection', list.map((pull) => pullNode(repo, pull)), args);
    }
    case 'pullRequest': {
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullNode(repo, pull);
    }
    case 'labels': {
      const list = [...repo.labels.values()].sort((a, b) => a.name.localeCompare(b.name));
      return connectionNode('LabelConnection', list.map((label) => node('Label', { label })), args);
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'isFork':
      return false;
    case 'isArchived':
      return false;
    default:
      throw unknownField(current, name);
  }
}

function resolveIssueField(current: GqlNode, name: string, args: Record<string, unknown>): unknown {
  const repo = current.repo as Repo;
  const issue = current.issue as IssueRec;
  switch (name) {
    case 'id':
      return globalId('Issue', issue.gid);
    case 'databaseId':
      return issue.gid;
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
    case 'bodyText':
      return issue.body;
    case 'state':
      return issue.state.toUpperCase();
    case 'url':
      return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
    case 'author':
      return userNode();
    case 'repository':
      return node('Repository', { repo });
    case 'labels': {
      const list = issue.labels.map((labelName) => repo.labels.get(labelName) ?? { name: labelName, color: 'ededed' });
      return connectionNode('LabelConnection', list.map((label) => node('Label', { label })), args);
    }
    case 'comments': {
      const list = [...issue.comments];
      return connectionNode('IssueCommentConnection', list.map((comment) => node('IssueComment', { comment })), args);
    }
    case 'createdAt':
      return issue.createdAt;
    case 'updatedAt':
      return issue.updatedAt;
    case 'closedAt':
      return issue.state === 'closed' ? issue.updatedAt : null;
    case 'viewerCanUpdate':
      return true;
    default:
      throw unknownField(current, name);
  }
}

function resolvePullField(current: GqlNode, name: string, args: Record<string, unknown>): unknown {
  const repo = current.repo as Repo;
  const pull = current.pull as PullRec;
  switch (name) {
    case 'id':
      return globalId('PullRequest', pull.gid);
    case 'databaseId':
      return pull.gid;
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
    case 'bodyText':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    case 'merged':
      return pull.merged;
    case 'mergedAt':
      return pull.mergedAt;
    case 'mergeCommit': {
      return pull.mergeCommitSha === null ? null : node('Commit', { repo, oid: pull.mergeCommitSha });
    }
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'headRefOid':
      return repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    case 'baseRefOid':
      return pull.merged ? pull.baseSha : repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    case 'url':
      return `/${repo.owner}/${repo.name}/pulls/${pull.number}`;
    case 'author':
      return userNode();
    case 'repository':
      return node('Repository', { repo });
    case 'createdAt':
      return pull.createdAt;
    case 'updatedAt':
      return pull.updatedAt;
    case 'closedAt':
      return pull.state === 'closed' ? pull.updatedAt : null;
    case 'additions':
      return pullFiles(repo, pull).reduce((sum, file) => sum + file.additions, 0);
    case 'deletions':
      return pullFiles(repo, pull).reduce((sum, file) => sum + file.deletions, 0);
    case 'changedFiles':
      return pullFiles(repo, pull).length;
    case 'mergeable':
      if (pull.state !== 'open') return 'UNKNOWN';
      return mergeWouldConflict(repo, pull.headRef, pull.baseRef) ? 'CONFLICTING' : 'MERGEABLE';
    case 'files': {
      const files = pullFiles(repo, pull).map((file) => node('PullRequestChangedFile', { path: file.path, additions: file.additions, deletions: file.deletions, status: file.status }));
      return connectionNode('PullRequestChangedFileConnection', files, args);
    }
    case 'commits': {
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      const oids = [...ancestors(repo, headTip).keys()].slice(0, 100);
      return connectionNode('PullRequestCommitConnection', oids.map((oid) => node('Commit', { repo, oid })), args);
    }
    default:
      throw unknownField(current, name);
  }
}

function mutationInput(args: Record<string, unknown>): Record<string, unknown> {
  return isRecord(args.input) ? args.input : args;
}

function repoFromInput(input: Record<string, unknown>): Repo | null {
  if (typeof input.repositoryId === 'string') {
    const decoded = decodeGlobalId(input.repositoryId);
    if (decoded !== null && decoded.type === 'Repository') return findRepoById(decoded.numericId);
  }
  if (typeof input.owner === 'string' && typeof input.name === 'string') return findRepo(input.owner, input.name);
  return null;
}

function resolveMutationField(name: string, args: Record<string, unknown>): unknown {
  const input = mutationInput(args);
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
  if (name === 'createIssue') {
    const repo = repoFromInput(input);
    if (repo === null) throw new FieldError('createIssue: repository not found');
    const title = String(input.title ?? '');
    const issue = createIssueRecord(repo, title, String(input.body ?? ''), []);
    return node('CreateIssuePayload', { repo, issue, clientMutationId });
  }
  if (name === 'closeIssue' || name === 'reopenIssue') {
    const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
    const found = decoded === null ? null : findIssueByGid(decoded.numericId);
    if (found === null) throw new FieldError(`${name}: issue not found`);
    found.issue.state = name === 'closeIssue' ? 'closed' : 'open';
    found.issue.updatedAt = nextStamp();
    return node('CloseIssuePayload', { repo: found.repo, issue: found.issue, clientMutationId });
  }
  if (name === 'createPullRequest') {
    const repo = repoFromInput(input);
    if (repo === null) throw new FieldError('createPullRequest: repository not found');
    const headRefName = String(input.headRefName ?? input.head ?? '');
    const baseRefName = String(input.baseRefName ?? input.base ?? repo.defaultBranch);
    const pull = createPullRecord(repo, String(input.title ?? ''), String(input.body ?? ''), headRefName, baseRefName);
    if (pull === null) throw new FieldError('createPullRequest: head or base branch does not exist');
    return node('CreatePullRequestPayload', { repo, pull, clientMutationId });
  }
  if (name === 'mergePullRequest') {
    const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
    const found = decoded === null ? null : findPullByGid(decoded.numericId);
    if (found === null) throw new FieldError('mergePullRequest: pull request not found');
    const outcome = mergePullRecord(found.repo, found.pull);
    if (!outcome.ok) throw new FieldError('mergePullRequest: pull request is not mergeable');
    return node('MergePullRequestPayload', { repo: found.repo, pull: found.pull, clientMutationId });
  }
  if (name === 'addComment') {
    const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
    const foundIssue = decoded === null ? null : findIssueByGid(decoded.numericId);
    if (foundIssue !== null) {
      const comment: CommentRec = { gid: nextGid, body: String(input.body ?? ''), createdAt: nextStamp() };
      nextGid += 1;
      foundIssue.issue.comments.push(comment);
      return node('AddCommentPayload', { repo: foundIssue.repo, issue: foundIssue.issue, comment, clientMutationId });
    }
    const foundPull = decoded === null ? null : findPullByGid(decoded.numericId);
    if (foundPull !== null) throw new FieldError('addComment: comments on pull requests are not supported here');
    throw new FieldError('addComment: subject not found');
  }
  throw new FieldError(`Field '${name}' doesn't exist on type 'Mutation'`);
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) return sendJson(res, 400, { errors: [{ message: 'Malformed JSON body' }] });
  const respond = (payload: Record<string, unknown>): void => {
    const value = parsed.value;
    void value;
    sendJson(res, 200, payload);
  };
  const runOne = (item: Record<string, unknown>): Record<string, unknown> => {
    const query = typeof item.query === 'string' ? item.query : '';
    const variables = isRecord(item.variables) ? item.variables : {};
    const operationName = typeof item.operationName === 'string' ? item.operationName : undefined;
    let operations: GqlOperation[];
    try {
      operations = new GqlParser(query).parseDocument(variables);
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
    }
    const operation = operations.find((op) => operationName === undefined || op.name === operationName) ?? operations[0];
    if (operation === undefined) return { data: null, errors: [{ message: 'No operation found' }] };
    const ctx: GqlCtx = { errors: [], vars: variables };
    const root = node(operation.type === 'mutation' ? 'Mutation' : 'Query', {});
    const data = execNode(root, operation.selections, ctx);
    const out: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) out.errors = ctx.errors;
    return out;
  };
  const rawValue: unknown = JSON.parse(raw.toString('utf8') || '{}');
  if (Array.isArray(rawValue)) {
    const results = rawValue.map((item) => runOne(isRecord(item) ? item : {}));
    return sendJson(res, 200, results);
  }
  return respond(runOne(parsed.value));
}

// ------------------------------------------------------------------ MCP

interface McpTool {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request body' },
      head: { type: 'string', description: 'Head branch name' },
      base: { type: 'string', description: 'Base branch name' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'number', description: 'Pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function mcpToolListJson(): string {
  return JSON.stringify(
    MCP_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
    })),
  );
}

interface RpcOutcome {
  status: number;
  payload: Record<string, unknown> | null;
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): RpcOutcome {
  return { status, payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolSuccess(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value) ?? 'null';
  const structured = isRecord(value) || Array.isArray(value) ? value : { value };
  return { content: [{ type: 'text', text }], structuredContent: structured, isError: false };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], structuredContent: { error: message }, isError: true };
}

function mcpCallTool(params: Record<string, unknown>): RpcOutcome {
  const name = typeof params.name === 'string' ? params.name : '';
  const args = isRecord(params.arguments) ? params.arguments : {};
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return rpcError(params.__id, -32601, `Method not found: unknown tool "${name}"`);
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return rpcError(params.__id, -32602, `Invalid params: missing required argument "${required}"`);
    }
  }
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      const repoNameNew = String(args.name);
      if (repos.has(repoKey(VIEWER_LOGIN, repoNameNew))) return rpcResult(params.__id, toolFailure(`repository "${repoNameNew}" already exists`));
      const repo = createRepoRecord(repoNameNew, args.private === true, typeof args.description === 'string' ? args.description : '');
      return rpcResult(params.__id, toolSuccess(repoJson(repo)));
    }
    case 'get_repo': {
      const repo = findRepo(owner, repoName);
      if (repo === null) return rpcResult(params.__id, toolFailure('repository not found'));
      return rpcResult(params.__id, toolSuccess(repoJson(repo)));
    }
    case 'create_issue': {
      const repo = findRepo(owner, repoName);
      if (repo === null) return rpcResult(params.__id, toolFailure('repository not found'));
      const issue = createIssueRecord(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return rpcResult(params.__id, toolSuccess(issueJson(repo, issue)));
    }
    case 'list_issues': {
      const repo = findRepo(owner, repoName);
      if (repo === null) return rpcResult(params.__id, toolFailure('repository not found'));
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      return rpcResult(params.__id, toolSuccess(list.map((issue) => issueJson(repo, issue))));
    }
    case 'create_pull_request': {
      const repo = findRepo(owner, repoName);
      if (repo === null) return rpcResult(params.__id, toolFailure('repository not found'));
      const head = String(args.head).split(':').pop() as string;
      const base = String(args.base).split(':').pop() as string;
      const pull = createPullRecord(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      if (pull === null) return rpcResult(params.__id, toolFailure('head or base branch does not exist'));
      return rpcResult(params.__id, toolSuccess(pullJson(repo, pull)));
    }
    case 'merge_pull_request': {
      const repo = findRepo(owner, repoName);
      if (repo === null) return rpcResult(params.__id, toolFailure('repository not found'));
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return rpcResult(params.__id, toolFailure('pull request not found'));
      const outcome = mergePullRecord(repo, pull);
      if (!outcome.ok) return rpcResult(params.__id, toolFailure(outcome.conflict ? 'merge conflict' : 'pull request is not mergeable'));
      return rpcResult(params.__id, toolSuccess({ ...pullJson(repo, pull), merged: true, sha: outcome.sha }));
    }
    default:
      return rpcError(params.__id, -32601, `Method not found: unknown tool "${name}"`);
  }
}

function mcpDispatch(message: Record<string, unknown>): RpcOutcome {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const params = isRecord(message.params) ? message.params : {};
  const isNotification = id === undefined;

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'complete',
      supportedVersions: [...MCP_REVISIONS],
      capabilities: { tools: {} },
      serverInfo: { name: 'makefun-forge', version: '1.0.0' },
      instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
      ttlMs: 0,
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISIONS[0];
    return rpcResult(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: 'makefun-forge', version: '1.0.0' },
      instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
    });
  }
  if (method.startsWith('notifications/')) return { status: 202, payload: null };
  if (isNotification) return { status: 202, payload: null };
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') {
    return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result: { tools: JSON.parse(mcpToolListJson()) as unknown } } };
  }
  if (method === 'tools/call') {
    return mcpCallTool({ ...params, __id: id });
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    const outcome = rpcError(null, -32700, 'Parse error: body is not valid JSON', 400);
    return sendJson(res, outcome.status, outcome.payload);
  }
  if (Array.isArray(value)) {
    const payloads: Array<Record<string, unknown>> = [];
    let status = 200;
    for (const item of value) {
      if (!isRecord(item)) continue;
      const outcome = mcpDispatch(item);
      if (outcome.payload !== null) payloads.push(outcome.payload);
      if (outcome.status !== 200 && outcome.status !== 202) status = outcome.status;
    }
    if (payloads.length === 0) {
      res.writeHead(202, { 'x-github-request-id': nextRequestId() });
      return res.end();
    }
    return sendJson(res, status, payloads);
  }
  if (!isRecord(value)) {
    const outcome = rpcError(null, -32600, 'Invalid Request', 400);
    return sendJson(res, outcome.status, outcome.payload);
  }
  const outcome = mcpDispatch(value);
  if (outcome.payload === null) {
    res.writeHead(outcome.status, { 'x-github-request-id': nextRequestId() });
    return res.end();
  }
  return sendJson(res, outcome.status, outcome.payload);
}

// ------------------------------------------------------------------ HTTP routing

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const path = url.pathname;

  if (path === '/healthz') {
    if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' });
    return sendJson(res, 200, { ok: true });
  }

  if (path === '/mcp') {
    if (method === 'GET' || method === 'DELETE') {
      return sendJson(res, 405, { message: 'Method Not Allowed' });
    }
    if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
    if (!authed(req)) return sendJson(res, 401, { message: 'Requires authentication' });
    return handleMcp(req, res);
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
    if (!authed(req)) return sendJson(res, 401, { errors: [{ message: 'Requires authentication' }] });
    return handleGraphql(req, res);
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authed(req)) return sendJson(res, 401, { message: 'Requires authentication' });
    let body: Record<string, unknown> = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      body = parsed.value;
    }
    const segments = path
      .replace(/^\/api\/v3\/?/, '')
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));
    return handleRest(req, res, { method, segments, query: url.searchParams, body, host: req.headers.host ?? 'forge.invalid' });
  }

  // Git smart HTTP: /<owner>/<repo>.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+?)\.git(\/.*)?$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1] as string);
    const repoName = decodeURIComponent(gitMatch[2] as string);
    const sub = gitMatch[3] ?? '';
    const repo = findRepo(owner, repoName);
    if (sub === '/info/refs' && method === 'GET') {
      if (repo === null) return sendJson(res, 404, { message: 'Not Found' });
      return handleGitInfoRefs(res, repo, url.searchParams, req.headers['git-protocol'] ?? '');
    }
    if ((sub === '/git-upload-pack' || sub === '/git-receive-pack') && method === 'POST') {
      const body = await readBody(req);
      if (repo === null) return sendJson(res, 404, { message: 'Not Found' });
      if (sub === '/git-upload-pack') return handleUploadPack(res, repo, body, req.headers['git-protocol'] ?? '');
      return handleReceivePack(res, repo, body);
    }
    return notFound(res);
  }

  return notFound(res);
}

export function createApp(): Server {
  const server = createHttpServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 75_000;
  return server;
}
