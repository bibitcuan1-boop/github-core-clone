// Git objects, packs and reachability, implemented from the wire format alone: no git
// binary, no library. Every function here is pure over Buffers and Maps, so the smart-HTTP
// handlers stay thin and the same code serves pushes, fetches and the REST contents API.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { COMMIT_EPOCH, VIEWER_EMAIL, VIEWER_NAME, ZERO_OID, type GitObject, type ObjType, type Repo } from './store.ts';

export { ZERO_OID };

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** A git object's id: SHA-1 over `<type> <size>\0` + bytes. */
export function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// --------------------------------------------------------------------------- commits

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
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

export function identityLine(ts: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
}

export function makeCommit(tree: string, parents: readonly string[], message: string, ts: number): { oid: string; data: Buffer } {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  const who = identityLine(ts);
  lines.push(`author ${who}`, `committer ${who}`, '', message);
  const data = Buffer.from(lines.join('\n'), 'utf8');
  return { oid: objectId('commit', data), data };
}

export function commitTs(data: Buffer): number {
  const { committer } = parseCommit(data);
  const m = / (\d+) \+0000$/.exec(committer);
  return m ? Number(m[1]) : COMMIT_EPOCH;
}

// --------------------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.toString('ascii', off, sp);
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0) break;
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git's tree order: names compare with directories as if they ended in '/'. */
function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function makeTree(entries: readonly TreeEntry[]): { oid: string; data: Buffer } {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.oid, 'hex'));
  }
  const data = Buffer.concat(parts);
  return { oid: objectId('tree', data), data };
}

/** Look a path up in a tree, one segment at a time; returns the entry or null. */
export function lookupPath(repo: Repo, treeOid: string, path: string): { entry: TreeEntry; parentTree: string } | null {
  const segments = path.split('/').filter((s) => s !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return { entry, parentTree: current };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** Replace (or add) one path in a tree, writing new tree objects; returns the new root oid. */
export function setPath(repo: Repo, treeOid: string | null, path: string, blobOid: string | null): string {
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) return treeOid ?? storeObject(repo, 'tree', Buffer.alloc(0));
  const build = (tree: string | null, depth: number): string => {
    const entries: TreeEntry[] = tree ? parseTree(repo.objects.get(tree)?.data ?? Buffer.alloc(0)) : [];
    const name = segments[depth];
    const isLast = depth === segments.length - 1;
    const idx = entries.findIndex((e) => e.name === name);
    if (isLast) {
      if (blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '100644', name, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name, oid: blobOid });
      }
    } else {
      const child = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : null;
      const newChild = build(child, depth + 1);
      const childEntries = parseTree(repo.objects.get(newChild)?.data ?? Buffer.alloc(0));
      if (childEntries.length === 0) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '40000', name, oid: newChild };
      } else {
        entries.push({ mode: '40000', name, oid: newChild });
      }
    }
    const { oid, data } = makeTree(entries);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(treeOid, 0);
}

/** Flatten a tree to path -> {oid, mode} for diffing. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') {
      for (const [k, v] of flattenTree(repo, e.oid, p)) out.set(k, v);
    } else {
      out.set(p, { oid: e.oid, mode: e.mode });
    }
  }
  return out;
}

// --------------------------------------------------------------------------- tags

export function makeTag(object: string, type: ObjType, tag: string, message: string, ts: number): { oid: string; data: Buffer } {
  const data = Buffer.from(`object ${object}\ntype ${type}\ntag ${tag}\ntagger ${identityLine(ts)}\n\n${message}`, 'utf8');
  return { oid: objectId('tag', data), data };
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

// --------------------------------------------------------------------------- packs

function encodeObjHeader(type: number, size: number): Buffer {
  const out: number[] = [];
  let b = (size & 0x0f) | (type << 4);
  size >>= 4;
  if (size > 0) b |= 0x80;
  out.push(b);
  while (size > 0) {
    b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    out.push(b);
  }
  return Buffer.from(out);
}

/** Build a packfile from plain objects (no deltas): PACK, version 2, count, entries, trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = TYPE_CODES[obj.type];
    parts.push(encodeObjHeader(typeCode, obj.data.length), deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** The compressed length of the deflate stream starting at `start`: binary-search the
 * smallest end that inflates to exactly `expectedSize` (inflateSync ignores trailing bytes). */
function deflateLength(buf: Buffer, start: number, expectedSize: number): number {
  const maxEnd = buf.length;
  let lo = start;
  let hi = maxEnd;
  const ok = (end: number): boolean => {
    try {
      return inflateSync(buf.subarray(start, end)).length === expectedSize;
    } catch {
      return false;
    }
  };
  if (!ok(maxEnd)) throw new Error('truncated deflate stream in pack');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo - start;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off];
      off += 1;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return v;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { cpOff |= delta[off] << (8 * i); off += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { cpSize |= delta[off] << (8 * i); off += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op > 0) {
      out.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || total !== dstSize) throw new Error('delta result size mismatch');
  return result;
}

/**
 * Read a packfile (version 2/3), resolving plain objects and OFS/REF deltas. `resolveBase`
 * supplies a base object the pack omits (a thin pack's base, which the server already holds).
 */
export function readPack(
  buf: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): { objects: Map<string, GitObject>; deltaCount: number } {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { oid: string; type: ObjType; data: Buffer }>();
  let deltaCount = 0;
  let off = 12;
  const pending: Array<{ offset: number; baseOid?: string; baseOffset?: number; data: Buffer; type: ObjType }> = [];
  for (let i = 0; i < count; i += 1) {
    const entryStart = off;
    let b = buf[off];
    off += 1;
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[off];
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint.
      b = buf[off];
      off += 1;
      let baseOff = b & 0x7f;
      while (b & 0x80) {
        b = buf[off];
        off += 1;
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryStart - baseOff;
    } else if (typeCode === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPES[typeCode]) {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
    const len = deflateLength(buf, off, size);
    const raw = inflateSync(buf.subarray(off, off + len));
    off += len;
    if (typeCode === 6 || typeCode === 7) {
      deltaCount += 1;
      pending.push({ offset: entryStart, baseOid, baseOffset, data: raw, type: 'blob' });
      continue;
    }
    const type = CODE_TYPES[typeCode];
    const oid = objectId(type, raw);
    const obj: GitObject = { type, data: raw };
    objects.set(oid, obj);
    byOffset.set(entryStart, { oid, type, data: raw });
  }
  // Resolve deltas in offset order (a delta's base always precedes it).
  for (const p of pending) {
    let base: GitObject | undefined;
    if (p.baseOffset !== undefined) base = byOffset.get(p.baseOffset);
    else if (p.baseOid !== undefined) base = objects.get(p.baseOid) ?? resolveBase?.(p.baseOid);
    if (!base) throw new Error('delta base not found in pack');
    const data = applyDelta(base.data, p.data);
    const oid = objectId(base.type, data);
    const obj: GitObject = { type: base.type, data };
    objects.set(oid, obj);
    byOffset.set(p.offset, { oid, type: base.type, data });
  }
  return { objects, deltaCount };
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const body = pack.subarray(0, pack.length - 20);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  return sha1Hex(body) === trailer;
}

// --------------------------------------------------------------------------- reachability

/** Every object reachable from `tips` (commits, their trees/blobs, tag targets), full closure. */
export function reachableObjects(repo: Repo, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Is `ancestor` reachable from `tip` (walking parents only)? */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

/** First-parent-ish merge base: the newest common ancestor of two commits (BFS by depth). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const distA = new Map<string, number>();
  const queue: Array<[string, number]> = [[a, 0]];
  while (queue.length > 0) {
    const [oid, d] = queue.shift()!;
    if (distA.has(oid)) continue;
    distA.set(oid, d);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push([p, d + 1]);
  }
  let best: string | null = null;
  let bestD = Infinity;
  const seenB = new Set<string>();
  const qb: Array<[string, number]> = [[b, 0]];
  while (qb.length > 0) {
    const [oid, d] = qb.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (distA.has(oid) && d + (distA.get(oid) ?? 0) < bestD) {
      bestD = d + (distA.get(oid) ?? 0);
      best = oid;
    }
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) qb.push([p, d + 1]);
  }
  return best;
}

/** Commits reachable from `tip`, newest first (BFS by generation, ties by insertion order). */
export function listCommits(repo: Repo, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}

// --------------------------------------------------------------------------- fetch planning

export interface FetchPlan {
  /** Objects to send, in pack order (commits first, then trees/blobs). */
  objects: GitObject[];
  /** New shallow boundaries (depth-limited tips whose parents exist but are not sent). */
  shallow: string[];
  /** Old shallow boundaries that now receive their parent. */
  unshallow: string[];
}

/**
 * Plan a fetch: `wants` minus everything reachable from `haves`, with an optional depth
 * limit. `knownShallow` is the client's current shallow boundary (for deepen/unshallow).
 * Two subtleties matter:
 *   - a shallow clone holds its boundary commit but NOT that commit's parents, so the
 *     held set is the closure of the haves truncated at the boundary;
 *   - a held want is still descended into (deepen asks for the parents of a commit the
 *     client already has);
 *   - a tag want contributes the tag object itself plus its target commit.
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  knownShallow: readonly string[],
): FetchPlan {
  const boundaries = new Set(knownShallow);
  const held = new Set<string>();
  {
    const stack = [...haves.filter((h) => repo.objects.has(h))];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (held.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      held.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        if (!boundaries.has(oid)) for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
  }
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  const toSend = new Set<string>();
  const maxDepth = depth === null || depth === 0 ? Infinity : depth;
  const commitDepth = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  const enqueueCommit = (oid: string, d: number): void => {
    if (!commitDepth.has(oid)) {
      commitDepth.set(oid, d);
      queue.push([oid, d]);
    }
  };
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'commit') {
      enqueueCommit(w, 0);
    } else if (obj.type === 'tag') {
      if (!held.has(w)) toSend.add(w);
      let target = parseTag(obj.data).object;
      let guard = 0;
      while (guard < 8) {
        const t = repo.objects.get(target);
        if (!t || t.type !== 'tag') break;
        if (!held.has(target)) toSend.add(target);
        target = parseTag(t.data).object;
        guard += 1;
      }
      if (repo.objects.get(target)?.type === 'commit') enqueueCommit(target, 0);
      else if (repo.objects.get(target) && !held.has(target)) toSend.add(target);
    } else if (!held.has(w)) {
      toSend.add(w);
    }
  }
  while (queue.length > 0) {
    const [oid, d] = queue.shift()!;
    if (d >= maxDepth) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (!held.has(oid)) toSend.add(oid);
    const c = parseCommit(obj.data);
    for (const p of c.parents) {
      if (held.has(p) || !repo.objects.has(p)) continue;
      if (d + 1 < maxDepth) enqueueCommit(p, d + 1);
      else shallowOut.push(oid);
    }
  }

  // Deepen: an old shallow boundary whose parent is now sent becomes unshallow.
  for (const s of knownShallow) {
    const obj = repo.objects.get(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((p) => toSend.has(p))) unshallowOut.push(s);
  }
  // A boundary is shallow only when it is sent, has parents in the store, and none of those
  // parents are sent or already held by the client.
  const realShallow = shallowOut.filter((oid) => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return false;
    const parents = parseCommit(obj.data).parents;
    return parents.length > 0 && parents.some((p) => repo.objects.has(p)) && parents.every((p) => !toSend.has(p) && !held.has(p));
  });

  // Trees and blobs for every sent commit, minus held objects.
  const ordered: GitObject[] = [];
  const seen = new Set<string>();
  const addTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (seen.has(t) || held.has(t)) continue;
      const obj = repo.objects.get(t);
      if (!obj) continue;
      seen.add(t);
      ordered.push(obj);
      if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          if (e.mode === '40000') stack.push(e.oid);
          else if (!seen.has(e.oid) && !held.has(e.oid)) {
            const blob = repo.objects.get(e.oid);
            if (blob) {
              seen.add(e.oid);
              ordered.push(blob);
            }
          }
        }
      }
    }
  };
  const commits: GitObject[] = [];
  const extras: GitObject[] = [];
  for (const oid of toSend) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      commits.push(obj);
      const c = parseCommit(obj.data);
      addTree(c.tree);
    } else {
      extras.push(obj);
    }
  }
  // Pack order: commits first (in the order discovered), then tags, then trees/blobs.
  const all = [...commits, ...extras, ...ordered.filter((o) => o.type !== 'commit')];
  return { objects: all, shallow: [...new Set(realShallow)], unshallow: [...new Set(unshallowOut)] };
}
