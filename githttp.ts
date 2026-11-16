// Git smart HTTP: the pkt-line codec and the upload-pack (v2 + v0) and receive-pack (v0)
// handlers. Every response is built to the exact shapes the suite's client parses
// (git-client.ts): v2 advertisements and sectioned fetch replies, v0 ref advertisements
// with capabilities on the first line, and sideband-framed push reports.

import { ZERO_OID, store, type Repo } from './store.ts';
import {
  isAncestor,
  makeCommit,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  planFetch,
  readPack,
  storeObject,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './gitobj.ts';

// --------------------------------------------------------------------------- pkt-line

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

function isHex(s: string): boolean {
  return /^[0-9a-fA-F]{4}$/.test(s);
}

/** Decode a whole buffer of pkt-lines. Throws on any malformed framing (callers 400 it). */
export function decodePackets(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line length');
    const hex = buf.toString('ascii', off, off + 4);
    if (!isHex(hex)) throw new Error('bad pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      off += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim' });
      off += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end' });
      off += 4;
    } else {
      if (len < 4 || len > 65520) throw new Error('bad pkt-line length');
      if (off + len > buf.length) throw new Error('truncated pkt-line');
      out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return out;
}

/** Decode pkt-lines and report the offset just past the first flush (for receive-pack packs). */
export function decodeUntilFlush(buf: Buffer): { packets: Packet[]; end: number } {
  const packets: Packet[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line length');
    const hex = buf.toString('ascii', off, off + 4);
    if (!isHex(hex)) throw new Error('bad pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      return { packets, end: off };
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || len > 65520 || off + len > buf.length) throw new Error('bad pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, end: off };
}

// --------------------------------------------------------------------------- refs

export interface RefLine {
  name: string;
  oid: string;
  /** True when the ref's target branch is unborn (only HEAD can be unborn here). */
  unborn?: boolean;
  peeled?: string;
  symrefTarget?: string;
}

/** All refs of a repo, HEAD first, then branches and tags sorted. */
export function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid) out.push({ name: 'HEAD', oid: headOid, symrefTarget: headTarget });
  else out.push({ name: 'HEAD', oid: ZERO_OID, unborn: true, symrefTarget: headTarget });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const obj = repo.objects.get(oid);
    let peeled: string | undefined;
    if (obj?.type === 'tag') {
      // Peel through tag objects to the underlying commit.
      let target = parseTag(obj.data).object;
      let guard = 0;
      while (guard < 8) {
        const t = repo.objects.get(target);
        if (!t || t.type !== 'tag') break;
        target = parseTag(t.data).object;
        guard += 1;
      }
      peeled = target;
    }
    out.push({ name, oid, peeled });
  }
  return out;
}

const UPLOAD_V2_CAPS: readonly string[] = [
  'version 2\n',
  'ls-refs=unborn\n',
  'fetch=shallow\n',
  'object-format=sha1\n',
  'agent=github-core-clone/1.0\n',
];
const UPLOAD_V0_CAPS = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack_detailed shallow';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

function v0RefAdvertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = listRefs(repo);
  if (refs.length === 1 && refs[0].unborn) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const r of refs) {
      const line = first ? `${r.oid} ${r.name}\0${caps}\n` : `${r.oid} ${r.name}\n`;
      parts.push(pktLine(line));
      first = false;
      if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- upload-pack

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  for (const r of listRefs(repo)) {
    if (!keep(r.name)) continue;
    if (r.unborn) {
      if (!unborn) continue;
      const extra = symrefs && r.symrefTarget ? ` symref-target:${r.symrefTarget}` : '';
      parts.push(pktLine(`unborn ${r.name}${extra}\n`));
      continue;
    }
    let line = `${r.oid} ${r.name}`;
    if (symrefs && r.symrefTarget) line += ` symref-target:${r.symrefTarget}`;
    if (peel && r.peeled) line += ` peeled:${r.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515; // 65520 pkt-line max, minus length prefix and the band byte
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

function fetchResponse(repo: Repo, args: string[], v2: boolean): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallowIn.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) depth = Number(a.slice(7).trim());
  }
  const plan = planFetch(repo, wants, haves, depth, shallowIn);
  const parts: Buffer[] = [];
  if (v2) {
    parts.push(pktLine('acknowledgments\n'));
    if (haves.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      let acked = false;
      for (const h of haves) {
        if (repo.objects.has(h)) {
          parts.push(pktLine(`ACK ${h}\n`));
          acked = true;
        }
      }
      if (!acked) parts.push(pktLine('NAK\n'));
      else parts.push(pktLine('ready\n'));
    }
    parts.push(FLUSH);
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(FLUSH);
    }
    const wanted = listRefs(repo).filter((r) => !r.unborn && wants.includes(r.oid));
    if (wanted.length > 0) {
      parts.push(pktLine('wanted-refs\n'));
      for (const r of wanted) parts.push(pktLine(`${r.oid} ${r.name}\n`));
      parts.push(FLUSH);
    }
    if (plan.objects.length > 0) {
      const pack = writePack(plan.objects);
      parts.push(pktLine('packfile\n'));
      parts.push(...sidebandPack(pack));
      parts.push(FLUSH);
    }
    return Buffer.concat(parts);
  }
  // v0: plain NAK/ACK/shallow lines, then the sideband pack, then flush.
  if (haves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    let acked = false;
    for (const h of haves) {
      if (repo.objects.has(h)) {
        parts.push(pktLine(`ACK ${h}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
  }
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(...sidebandPack(pack));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Parse a v2 command body: `command=X`, delim, args, flush. */
function parseV2Command(body: Buffer): { command: string; args: string[] } {
  const packets = decodePackets(body);
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice(8);
    } else {
      args.push(line);
    }
  }
  if (!command) throw new Error('no v2 command');
  return { command, args };
}

/** Parse a v0 fetch body: wants (+shallow/deepen), flush, haves + done, flush. */
function parseV0Fetch(body: Buffer): string[] {
  const packets = decodePackets(body);
  const args: string[] = [];
  for (const p of packets) {
    if (p.kind === 'flush') continue;
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // The first want may carry features after the oid: `want <oid> side-band-64k ...`.
      args.push(`want ${line.slice(5).split(' ')[0]}`);
    } else if (line === 'done') {
      // Negotiation terminator; nothing to plan from it.
    } else {
      args.push(line);
    }
  }
  return args;
}

// --------------------------------------------------------------------------- receive-pack

export interface PushOutcome {
  unpackOk: boolean;
  unpackDetail: string;
  refs: Array<{ ref: string; ok: boolean; reason: string }>;
  /** True when the request asked for side-band-64k framing of the report. */
  useSideband: boolean;
}

export function handleReceivePack(repo: Repo, body: Buffer): PushOutcome {
  const { packets, end } = decodeUntilFlush(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let useSideband = false;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    let text = line;
    if (nul >= 0) {
      text = line.slice(0, nul);
      const caps = line.slice(nul + 1).split(' ');
      if (caps.includes('side-band-64k')) useSideband = true;
    }
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const packBytes = body.subarray(end);
  const hasPack = packBytes.length > 0;
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (hasPack) {
    try {
      if (!verifyPackChecksum(packBytes)) throw new Error('pack checksum mismatch');
      const { objects } = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  } else if (updatesRef) {
    unpackOk = false;
    unpackDetail = 'unpacker error';
  }
  const refs: PushOutcome['refs'] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    const fail = (reason: string): void => refs.push({ ref: cmd.ref, ok: false, reason });
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) fail('remote ref does not exist');
      else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) fail('non-fast-forward');
      else {
        repo.refs.delete(cmd.ref);
        refs.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    const newObj = repo.objects.get(cmd.newOid);
    if (!newObj) {
      fail('missing object');
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) fail('already exists');
      else {
        repo.refs.set(cmd.ref, cmd.newOid);
        refs.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: old must be current, and new must descend from old.
    if (current !== cmd.oldOid) {
      fail('non-fast-forward');
      continue;
    }
    if (newObj.type === 'commit' && !isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    refs.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  return { unpackOk, unpackDetail, refs, useSideband };
}

export function pushReportBody(outcome: PushOutcome): Buffer {
  const lines: string[] = [`unpack ${outcome.unpackDetail}`];
  for (const r of outcome.refs) {
    lines.push(r.ok ? `ok ${r.ref}` : `ng ${r.ref} ${r.reason}`);
  }
  const inner = Buffer.concat(lines.map((l) => pktLine(`${l}\n`)));
  const parts: Buffer[] = [];
  if (outcome.useSideband) {
    // The report is pkt-lined inside sideband band 1; chunk it like any pack payload.
    const CHUNK = 65515;
    for (let off = 0; off < inner.length; off += CHUNK) {
      const slice = inner.subarray(off, Math.min(off + CHUNK, inner.length));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  } else {
    parts.push(inner);
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- entry points

export type GitResult =
  | { status: 200; contentType: string; body: Buffer }
  | { status: 404; contentType: string; body: Buffer }
  | { status: 400; contentType: string; body: Buffer };

const NOT_FOUND = Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8');
const BAD_REQUEST = Buffer.from('bad request', 'utf8');

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(repo: Repo | undefined, service: string, gitProtocol: string | null): GitResult {
  if (!repo) return { status: 404, contentType: 'application/json; charset=utf-8', body: NOT_FOUND };
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    const body = Buffer.concat([...UPLOAD_V2_CAPS.map((line) => pktLine(line)), FLUSH]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  if (service === 'git-upload-pack') {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0RefAdvertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0RefAdvertisement(repo, 'git-receive-pack') };
  }
  return { status: 404, contentType: 'application/json; charset=utf-8', body: NOT_FOUND };
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(repo: Repo | undefined, body: Buffer, gitProtocol: string | null): GitResult {
  if (!repo) return { status: 404, contentType: 'application/json; charset=utf-8', body: NOT_FOUND };
  try {
    if (gitProtocol === 'version=2') {
      const { command, args } = parseV2Command(body);
      if (command === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, args) };
      }
      if (command === 'fetch') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponse(repo, args, true) };
      }
      return { status: 400, contentType: 'text/plain; charset=utf-8', body: BAD_REQUEST };
    }
    const args = parseV0Fetch(body);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponse(repo, args, false) };
  } catch {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: BAD_REQUEST };
  }
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePackHttp(repo: Repo | undefined, body: Buffer): GitResult {
  if (!repo) return { status: 404, contentType: 'application/json; charset=utf-8', body: NOT_FOUND };
  try {
    const outcome = handleReceivePack(repo, body);
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: pushReportBody(outcome) };
  } catch {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: BAD_REQUEST };
  }
}

/** Re-exported for the REST contents API: build a commit on a branch from a tree change.
 * When the branch does not exist yet, `baseTip` (usually the default branch tip) is the
 * commit the new branch starts from; without it the branch starts unborn. */
export function commitOnBranch(
  repo: Repo,
  branch: string,
  message: string,
  mutate: (treeOid: string | null) => string | null,
  baseTip?: string | null,
): { commitOid: string; treeOid: string } {
  const ref = `refs/heads/${branch}`;
  const current = repo.refs.get(ref) ?? baseTip ?? null;
  const baseTree = current ? parseCommit(repo.objects.get(current)!.data).tree : null;
  const newTree = mutate(baseTree);
  if (newTree === null) throw new Error('no tree change');
  const parents = current ? [current] : [];
  const ts = store.nextCommitTs();
  const { oid, data } = makeCommit(newTree, parents, message, ts);
  storeObject(repo, 'commit', data);
  repo.refs.set(ref, oid);
  return { commitOid: oid, treeOid: newTree };
}
