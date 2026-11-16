// The in-memory store: every repository, git object, ref, issue, pull request, label and
// comment the entry serves. All state lives here, in Maps, so the request path never touches
// disk. Nothing in this file knows about HTTP: it is the model the REST, GraphQL, MCP and
// git handlers all share, so an issue created over MCP reads back identically over REST.

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The scenario's viewer, from the kit's constant seed (wire.ts SCENARIO_SEED). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** One fixed timestamp for every REST created_at/updated_at: replays must be byte-identical. */
export const FIXED_DATE = '2024-01-01T00:00:00.000Z';
/** Base epoch for server-created git commits; each commit takes the next second. */
export const COMMIT_EPOCH = 1700000000;

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: IssueComment[];
}

export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  prs: Map<number, PullRequest>;
  nextNumber: number;
  labels: Map<string, Label>;
  nextCommentId: number;
}

const DEFAULT_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['bug', 'd73a4a'],
  ['enhancement', 'a2eeef'],
  ['documentation', '0075ca'],
  ['question', 'd876e3'],
  ['good first issue', '7057ff'],
  ['help wanted', '008672'],
];

export class Store {
  /** The viewer login. Rebinds once, while the store is still empty, if the first owner-scoped
   * request names someone else (the seed is constant, so this is belt-and-braces only). */
  viewerLogin = VIEWER_LOGIN;
  readonly repos = new Map<string, Repo>();
  nextRepoId = 5000;
  /** Deterministic commit clock: COMMIT_EPOCH + commitSeq seconds. */
  private commitSeq = 0;
  /** Deterministic X-GitHub-Request-Id counter. */
  reqSeq = 0;

  nextCommitTs(): number {
    return COMMIT_EPOCH + (this.commitSeq += 1);
  }

  nextRequestId(): string {
    this.reqSeq += 1;
    return `req-${String(this.reqSeq).padStart(6, '0')}`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** The owner a request naming `name` may address, or null when it must 404. */
  resolveOwner(name: string): string | null {
    if (name === this.viewerLogin) return name;
    if (this.repos.size === 0) {
      this.viewerLogin = name;
      return name;
    }
    return null;
  }

  createRepo(name: string, opts: { private?: boolean; description?: string; defaultBranch?: string } = {}): Repo | null {
    if (this.repos.has(this.key(this.viewerLogin, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: this.viewerLogin,
      private: opts.private ?? false,
      description: opts.description ?? '',
      defaultBranch: opts.defaultBranch ?? 'main',
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      prs: new Map(),
      nextNumber: 1,
      labels: new Map(),
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    for (const [label, color] of DEFAULT_LABELS) {
      repo.labels.set(label, { name: label, color, description: '' });
    }
    this.repos.set(this.key(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** The next shared issue/PR number for a repo (GitHub numbers issues and PRs together). */
  nextNumber(repo: Repo): number {
    const n = repo.nextNumber;
    repo.nextNumber += 1;
    return n;
  }
}

/** The one store for the process. */
export const store = new Store();
