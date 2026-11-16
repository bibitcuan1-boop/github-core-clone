// GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments and
// pull requests, over the one in-memory store. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors are JSON {message}; unknown routes are 404 JSON.

import { FIXED_DATE, VIEWER_EMAIL, VIEWER_NAME, store, type Issue, type Label, type PullRequest, type Repo } from './store.ts';
import {
  commitTs,
  flattenTree,
  listCommits,
  lookupPath,
  makeCommit,
  makeTree,
  mergeBase,
  parseCommit,
  parseTree,
  setPath,
  storeObject,
} from './gitobj.ts';
import { commitOnBranch } from './githttp.ts';

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** When true, send no body at all (204). */
  empty?: boolean;
}

export interface RestCtx {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  /** Absolute origin of this request, for pagination Link headers. */
  origin: string;
}

const notFound = (message = 'Not Found'): RestResponse => ({ status: 404, body: { message } });
const badRequest = (message: string): RestResponse => ({ status: 400, body: { message } });
const unprocessable = (message: string): RestResponse => ({ status: 422, body: { message } });
const ok = (body: unknown, headers?: Record<string, string>): RestResponse => ({ status: 200, body, headers });
const created = (body: unknown): RestResponse => ({ status: 201, body });

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function isoFromTs(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

// --------------------------------------------------------------------------- shapes

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === store.viewerLogin ? 1000 : 1002, type: 'User', html_url: `https://github.com/${login}`, url: `/api/v3/users/${login}` };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length
    + [...repo.prs.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(repo.owner),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    pushed_at: FIXED_DATE,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: 0, name: label.name, color: label.color, description: label.description, url: '' };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.user),
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
  };
}

export function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const side = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(repo.owner),
    repo: repoJson(repo),
  });
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    user: userJson(pr.user),
    head: side(pr.headRef, pr.headSha),
    base: side(pr.baseRef, pr.baseSha),
    merged: pr.merged,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    mergeable: prMergeable(repo, pr),
    draft: false,
    locked: false,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.state === 'closed' ? (pr.merged_at ?? FIXED_DATE) : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return { sha: oid, commit: { message: '' } };
  const c = parseCommit(obj.data);
  const ts = commitTs(obj.data);
  const date = isoFromTs(ts);
  return {
    sha: oid,
    node_id: '',
    commit: {
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date },
      message: c.message,
      tree: { sha: c.tree },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned' },
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}` })),
    author: userJson(store.viewerLogin),
    committer: userJson(store.viewerLogin),
  };
}

// --------------------------------------------------------------------------- pagination

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  return { perPage, page };
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; headers: Record<string, string>; total: number } {
  const { perPage, page } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), headers: {}, total: totalPages };
}

/** Build a GitHub Link header for a list endpoint, from the request origin and query. */
function linkHeader(ctx: RestCtx, path: string, totalPages: number): Record<string, string> {
  const { perPage, page } = pageParams(ctx.query);
  if (totalPages <= 1) return {};
  const base = `${ctx.origin}${path}`;
  const links: string[] = [];
  const url = (p: number): string => `${base}?per_page=${perPage}&page=${p}`;
  if (page < totalPages) links.push(`<${url(page + 1)}>; rel="next"`);
  links.push(`<${url(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${url(1)}>; rel="first"`, `<${url(page - 1)}>; rel="prev"`);
  return { Link: links.join(', ') };
}

// --------------------------------------------------------------------------- repo lookup

function repoFrom(ctx: RestCtx, owner: string, name: string): Repo | null {
  const resolved = store.resolveOwner(owner);
  if (resolved === null) return null;
  return store.getRepo(resolved, name) ?? null;
}

// --------------------------------------------------------------------------- merge machinery

/** Three-way merge of base-tip vs head, against their merge base. Null when conflicted. */
export function threeWayMerge(repo: Repo, baseTip: string, headTip: string, mergeBaseOid: string | null): Map<string, { oid: string; mode: string }> | null {
  const base = mergeBaseOid ? flattenTree(repo, parseCommit(repo.objects.get(mergeBaseOid)!.data).tree) : new Map();
  const head = flattenTree(repo, parseCommit(repo.objects.get(headTip)!.data).tree);
  const tip = flattenTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
  const out = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...base.keys(), ...head.keys(), ...tip.keys()]);
  for (const p of paths) {
    const b = base.get(p);
    const h = head.get(p);
    const t = tip.get(p);
    if (h?.oid === b?.oid) {
      // Unchanged in head: keep the base tip's version (or its absence).
      if (t) out.set(p, t);
    } else if (t?.oid === b?.oid) {
      // Changed only in head: take head's version.
      if (h) out.set(p, h);
    } else if (h?.oid === t?.oid) {
      // Same change on both sides: keep it.
      if (h) out.set(p, h);
    } else {
      return null; // Both sides changed the path differently: conflict.
    }
  }
  return out;
}

/** A PR's live head/base tips: branches move after a PR is created, and GitHub merges
 * against their current tips, not the shas captured at creation. */
export function liveTips(repo: Repo, pr: PullRequest): { headSha: string; baseSha: string } {
  return {
    headSha: repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha,
    baseSha: repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha,
  };
}

/** Whether a PR can merge cleanly (null when either tip is missing). */
export function prMergeable(repo: Repo, pr: PullRequest): boolean | null {
  if (pr.state !== 'open') return false;
  const { headSha, baseSha } = liveTips(repo, pr);
  const headObj = repo.objects.get(headSha);
  const baseObj = repo.objects.get(baseSha);
  if (!headObj || !baseObj) return null;
  const mb = mergeBase(repo, baseSha, headSha);
  return threeWayMerge(repo, baseSha, headSha, mb) !== null;
}

function writeTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  // Build nested trees bottom-up from the flat path map.
  interface TreeNode {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, TreeNode>;
  }
  const newNode = (): TreeNode => ({ files: new Map(), dirs: new Map() });
  const rootNode = newNode();
  const sorted = [...flat.keys()].sort();
  for (const p of sorted) {
    const segs = p.split('/');
    let node = rootNode;
    for (let i = 0; i < segs.length - 1; i += 1) {
      let child = node.dirs.get(segs[i]);
      if (!child) {
        child = newNode();
        node.dirs.set(segs[i], child);
      }
      node = child;
    }
    node.files.set(segs[segs.length - 1], flat.get(p)!);
  }
  const writeNode = (node: TreeNode): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    for (const [name, f] of node.files) entries.push({ mode: f.mode, name, oid: f.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: writeNode(child) });
    const { oid, data } = makeTree(entries);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return writeNode(rootNode);
}

/** Squash-merge a PR onto its base branch. Returns the merge commit oid, or null on conflict. */
export function squashMerge(repo: Repo, pr: PullRequest): string | null {
  const { headSha, baseSha } = liveTips(repo, pr);
  const mb = mergeBase(repo, baseSha, headSha);
  const merged = threeWayMerge(repo, baseSha, headSha, mb);
  if (merged === null) return null;
  const treeOid = writeTreeFromFlat(repo, merged);
  const ts = store.nextCommitTs();
  const { oid, data } = makeCommit(treeOid, [baseSha], pr.title, ts);
  storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pr.baseRef}`, oid);
  pr.headSha = headSha;
  pr.baseSha = baseSha;
  return oid;
}

/** Files changed between the merge base and the head, with line counts. */
function prFiles(repo: Repo, pr: PullRequest): Array<Record<string, unknown>> {
  const { headSha, baseSha } = liveTips(repo, pr);
  const mb = mergeBase(repo, baseSha, headSha);
  const base = mb ? flattenTree(repo, parseCommit(repo.objects.get(mb)!.data).tree) : new Map<string, { oid: string; mode: string }>();
  const head = flattenTree(repo, parseCommit(repo.objects.get(headSha)!.data).tree);
  const out: Array<Record<string, unknown>> = [];
  const countLines = (oid: string): number => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'blob') return 0;
    const text = obj.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  const lineSet = (oid: string): Set<string> => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'blob') return new Set();
    return new Set(obj.data.toString('utf8').split('\n'));
  };
  for (const p of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const b = base.get(p);
    const h = head.get(p);
    if (b?.oid === h?.oid) continue;
    let status: string;
    let additions = 0;
    let deletions = 0;
    if (!b && h) {
      status = 'added';
      additions = countLines(h.oid);
    } else if (b && !h) {
      status = 'removed';
      deletions = countLines(b.oid);
    } else if (b && h) {
      status = 'modified';
      const oldLines = lineSet(b.oid);
      const newLines = lineSet(h.oid);
      for (const l of newLines) if (!oldLines.has(l)) additions += 1;
      for (const l of oldLines) if (!newLines.has(l)) deletions += 1;
      if (additions === 0 && deletions === 0) additions = 1; // bytes differ but line sets match
    } else {
      continue;
    }
    out.push({ filename: p, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

// --------------------------------------------------------------------------- contents

function contentsPathSegments(ctx: RestCtx): string[] {
  // segments after repos/{o}/{r}/contents
  return ctx.segments.slice(4);
}

function resolveRefTip(repo: Repo, ref: string | null): string | null {
  if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
  if (repo.objects.get(ref)?.type === 'commit') return ref;
  return null;
}

function contentsGet(repo: Repo, ctx: RestCtx): RestResponse {
  const path = contentsPathSegments(ctx).map(decodeURIComponent).join('/');
  const tip = resolveRefTip(repo, ctx.query.get('ref'));
  if (tip === null) return notFound('Not Found');
  const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
  if (path === '') {
    // Root listing.
    const entries = parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
    return ok(entries.map((e) => contentEntry(repo, e, '')));
  }
  const found = lookupPath(repo, treeOid, path);
  if (!found) return notFound('Not Found');
  const { entry } = found;
  if (entry.mode === '40000') {
    const entries = parseTree(repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0));
    return ok(entries.map((e) => contentEntry(repo, e, path)));
  }
  const blob = repo.objects.get(entry.oid);
  if (!blob) return notFound('Not Found');
  return ok({
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name: entry.name,
    path,
    content: blob.data.toString('base64'),
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
    download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
  });
}

function contentEntry(repo: Repo, e: { mode: string; name: string; oid: string }, dir: string): Record<string, unknown> {
  const path = dir === '' ? e.name : `${dir}/${e.name}`;
  const isDir = e.mode === '40000';
  const blob = isDir ? null : repo.objects.get(e.oid);
  return {
    type: isDir ? 'dir' : 'file',
    size: blob ? blob.data.length : 0,
    name: e.name,
    path,
    sha: e.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${e.oid}`,
    download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
  };
}

function contentsPut(repo: Repo, ctx: RestCtx): RestResponse {
  const body = isRecord(ctx.body) ? ctx.body : {};
  const path = contentsPathSegments(ctx).map(decodeURIComponent).join('/');
  if (path === '') return badRequest('Invalid path');
  const message = str(body.message, 'Update file');
  const contentB64 = str(body.content);
  if (contentB64 === '') return badRequest('content is required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return badRequest('content is not valid base64');
  }
  const branch = str(body.branch, repo.defaultBranch);
  const blobOid = storeObject(repo, 'blob', content);
  const ref = `refs/heads/${branch}`;
  const currentTip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const currentTree = currentTip ? parseCommit(repo.objects.get(currentTip)!.data).tree : null;
  const existing = currentTree ? lookupPath(repo, currentTree, path) : null;
  const isUpdate = existing !== null;
  if (isUpdate) {
    const sha = str(body.sha);
    if (sha === '') return unprocessable('sha is required to update a file');
    if (sha !== existing.entry.oid) return { status: 409, body: { message: 'sha does not match the current file' } };
  }
  const { commitOid } = commitOnBranch(repo, branch, message, (tree) => setPath(repo, tree, path, blobOid), currentTip);
  return {
    status: isUpdate ? 200 : 201,
    body: {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, url: '', html_url: '', git_url: '', download_url: '', type: 'file', encoding: 'base64' },
      commit: { sha: commitOid, message },
    },
  };
}

function contentsDelete(repo: Repo, ctx: RestCtx): RestResponse {
  const body = isRecord(ctx.body) ? ctx.body : {};
  const path = contentsPathSegments(ctx).map(decodeURIComponent).join('/');
  if (path === '') return badRequest('Invalid path');
  const message = str(body.message, 'Delete file');
  const branch = str(body.branch, repo.defaultBranch);
  const ref = `refs/heads/${branch}`;
  const currentTip = repo.refs.get(ref);
  if (!currentTip) return notFound('Not Found');
  const currentTree = parseCommit(repo.objects.get(currentTip)!.data).tree;
  const existing = lookupPath(repo, currentTree, path);
  if (!existing) return notFound('Not Found');
  const sha = str(body.sha);
  if (sha !== '' && sha !== existing.entry.oid) return { status: 409, body: { message: 'sha does not match the current file' } };
  const { commitOid } = commitOnBranch(repo, branch, message, (tree) => setPath(repo, tree, path, null));
  return ok({ commit: { sha: commitOid, message }, content: null });
}

// --------------------------------------------------------------------------- router

export function handleRest(ctx: RestCtx): RestResponse {
  const { method, segments } = ctx;

  // API root and meta.
  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
    if (method === 'GET') {
      return ok(
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }
    return notFound();
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') return ok({ installed_version: '1.0.0' });
    return notFound();
  }
  if (segments[0] === 'user' && segments.length === 1) {
    return notFound();
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const all = [...store.repos.values()]
        .filter((r) => r.owner === store.viewerLogin)
        .sort((a, b) => a.id - b.id)
        .map(repoJson);
      const { page, total } = paginate(all, ctx.query);
      const path = '/api/v3/user/repos';
      return ok(page, linkHeader(ctx, path, total));
    }
    if (method === 'POST') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const name = str(body.name);
      if (!name) return badRequest('name is required');
      const repo = store.createRepo(name, {
        private: body.private === true,
        description: str(body.description),
        defaultBranch: str(body.default_branch, 'main') || 'main',
      });
      if (!repo) return unprocessable('Repository already exists');
      return created(repoJson(repo));
    }
    return notFound();
  }

  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const owner = decodeURIComponent(segments[1]);
  const name = decodeURIComponent(segments[2]);
  const repo = repoFrom(ctx, owner, name);
  if (!repo) return notFound('Not Found');
  const rest = segments.slice(3);

  // /repos/{o}/{r} itself.
  if (rest.length === 0) {
    if (method === 'GET') return ok(repoJson(repo));
    if (method === 'PATCH') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      return ok(repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: null, empty: true };
    }
    return notFound();
  }

  const sub = rest[0];

  // Branches.
  if (sub === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .sort()
        .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r), url: '' }, protected: false }));
      return ok(list);
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(rest[1]);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return notFound('Branch not found');
      return ok({ name: branch, commit: { sha, url: '' }, protected: false });
    }
    return notFound();
  }

  // git refs.
  if (sub === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || !sha) return unprocessable('ref and sha are required');
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      const obj = repo.objects.get(sha);
      if (!obj) return unprocessable('Invalid sha');
      repo.refs.set(ref, sha);
      return created({ ref, node_id: '', url: '', object: { sha, type: obj.type, url: '' } });
    }
    if (method === 'GET' && rest.length >= 3) {
      const refPath = rest.slice(2).map(decodeURIComponent).join('/');
      const ref = `refs/${refPath}`;
      const sha = repo.refs.get(ref);
      if (!sha) return notFound('Not Found');
      return ok({ ref, node_id: '', url: '', object: { sha, type: 'commit', url: '' } });
    }
    return notFound();
  }

  // Commits.
  if (sub === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const ref = ctx.query.get('sha');
      const tip = resolveRefTip(repo, ref);
      if (!tip) return notFound('Not Found');
      const all = listCommits(repo, tip).map((oid) => commitJson(repo, oid));
      const { page } = paginate(all, ctx.query);
      return ok(page);
    }
    if (method === 'GET' && rest.length === 2) {
      const sha = decodeURIComponent(rest[1]);
      if (!repo.objects.get(sha)) return notFound('Not Found');
      return ok(commitJson(repo, sha));
    }
    return notFound();
  }

  // Contents.
  if (sub === 'contents') {
    if (method === 'GET') return contentsGet(repo, ctx);
    if (method === 'PUT') return contentsPut(repo, ctx);
    if (method === 'DELETE') return contentsDelete(repo, ctx);
    return notFound();
  }

  // Labels.
  if (sub === 'labels') {
    if (method === 'GET' && rest.length === 1) return ok([...repo.labels.values()].map(labelJson));
    if (method === 'POST' && rest.length === 1) {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const labelName = str(body.name);
      const color = str(body.color, 'ededed');
      if (!labelName) return badRequest('name is required');
      // Idempotent: creating a label that already exists (including a default one)
      // answers 201 with the existing label.
      const existing = repo.labels.get(labelName);
      if (existing) return created(labelJson(existing));
      const label: Label = { name: labelName, color, description: str(body.description) };
      repo.labels.set(labelName, label);
      return created(labelJson(label));
    }
    return notFound();
  }

  // Issues.
  if (sub === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const title = str(body.title);
        if (!title) return badRequest('title is required');
        const labelNames: string[] = [];
        if (Array.isArray(body.labels)) {
          for (const l of body.labels) {
            if (typeof l === 'string') labelNames.push(l);
            else if (isRecord(l) && typeof l.name === 'string') labelNames.push(l.name);
          }
        }
        const labels: Label[] = [];
        for (const n of labelNames) {
          const label = repo.labels.get(n);
          if (!label) return unprocessable(`Label does not exist: ${n}`);
          labels.push(label);
        }
        const number = store.nextNumber(repo);
        const issue: Issue = {
          number,
          id: repo.id * 1_000_000 + number,
          title,
          body: str(body.body),
          state: 'open',
          labels,
          user: store.viewerLogin,
          created_at: FIXED_DATE,
          updated_at: FIXED_DATE,
          closed_at: null,
          comments: [],
        };
        repo.issues.set(number, issue);
        return created(issueJson(repo, issue));
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const direction = ctx.query.get('direction') ?? 'desc';
        let all = [...repo.issues.values()];
        if (state !== 'all') all = all.filter((i) => i.state === state);
        all.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const { page, total } = paginate(all.map((i) => issueJson(repo, i)), ctx.query);
        return ok(page, linkHeader(ctx, `/api/v3/repos/${owner}/${name}/issues`, total));
      }
      return notFound();
    }
    const n = Number(rest[1]);
    if (!Number.isInteger(n)) return notFound();
    if (rest.length === 2) {
      const issue = repo.issues.get(n);
      if (!issue) return notFound('Not Found');
      if (method === 'GET') return ok(issueJson(repo, issue));
      if (method === 'PATCH') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') {
          issue.state = body.state;
          issue.closed_at = body.state === 'closed' ? FIXED_DATE : null;
        }
        return ok(issueJson(repo, issue));
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      const issue = repo.issues.get(n);
      if (!issue) return notFound('Not Found');
      if (method === 'GET') {
        return ok(issue.comments.map((c) => ({
          id: c.id,
          body: c.body,
          user: userJson(c.user),
          created_at: c.created_at,
          updated_at: c.updated_at,
          html_url: '',
          url: '',
          issue_url: `/api/v3/repos/${owner}/${name}/issues/${n}`,
        })));
      }
      if (method === 'POST') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const commentBody = str(body.body);
        if (!commentBody) return badRequest('body is required');
        const comment = {
          id: repo.nextCommentId,
          body: commentBody,
          user: store.viewerLogin,
          created_at: FIXED_DATE,
          updated_at: FIXED_DATE,
        };
        repo.nextCommentId += 1;
        issue.comments.push(comment);
        return created({
          id: comment.id,
          body: comment.body,
          user: userJson(comment.user),
          created_at: comment.created_at,
          updated_at: comment.updated_at,
          html_url: '',
          url: '',
          issue_url: `/api/v3/repos/${owner}/${name}/issues/${n}`,
        });
      }
      return notFound();
    }
    return notFound();
  }

  // Pull requests.
  if (sub === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const head = str(body.head);
        const base = str(body.base);
        const title = str(body.title);
        if (!head || !base || !title) return badRequest('head, base and title are required');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) return unprocessable('head or base branch does not exist');
        for (const p of repo.prs.values()) {
          if (p.state === 'open' && p.headRef === head && p.baseRef === base) {
            return unprocessable('A pull request already exists for this head branch');
          }
        }
        const number = store.nextNumber(repo);
        const pr: PullRequest = {
          number,
          id: repo.id * 1_000_000 + number,
          title,
          body: str(body.body),
          state: 'open',
          headRef: head,
          headSha,
          baseRef: base,
          baseSha,
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
          user: store.viewerLogin,
          created_at: FIXED_DATE,
          updated_at: FIXED_DATE,
        };
        repo.prs.set(number, pr);
        return created(prJson(repo, pr));
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let all = [...repo.prs.values()];
        if (state !== 'all') all = all.filter((p) => p.state === state);
        all.sort((a, b) => b.number - a.number);
        const { page, total } = paginate(all.map((p) => prJson(repo, p)), ctx.query);
        return ok(page, linkHeader(ctx, `/api/v3/repos/${owner}/${name}/pulls`, total));
      }
      return notFound();
    }
    const n = Number(rest[1]);
    if (!Number.isInteger(n)) return notFound();
    const pr = repo.prs.get(n);
    if (!pr) return notFound('Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return ok(prJson(repo, pr));
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      return ok(prFiles(repo, pr));
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pr.state !== 'open') return { status: 405, body: { message: 'Pull request is already closed' } };
      const mergeSha = squashMerge(repo, pr);
      if (mergeSha === null) return { status: 405, body: { message: 'Merge conflict' } };
      pr.state = 'closed';
      pr.merged = true;
      pr.merged_at = FIXED_DATE;
      pr.merge_commit_sha = mergeSha;
      return ok({ merged: true, sha: mergeSha, message: pr.title });
    }
    return notFound();
  }

  return notFound();
}
