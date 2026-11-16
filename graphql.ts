// GitHub GraphQL v4: a small hand-rolled parser and resolver for the documents `gh` and
// `github-mcp-server` send. It is not a general GraphQL engine: it parses the query/mutation
// documents the suite uses (variables, inline input objects, aliases, inline fragments,
// batched arrays) and resolves them against the same store as REST, so a mutation made
// over GraphQL reads back identically over REST.

import { FIXED_DATE, store, type Issue, type PullRequest, type Repo } from './store.ts';
import { flattenTree, mergeBase, parseCommit } from './gitobj.ts';
import { squashMerge, prMergeable, liveTips } from './rest.ts';

// --------------------------------------------------------------------------- ids

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

export function repoGlobalId(repo: Repo): string {
  return b64(`Repository:${repo.id}`);
}
export function issueGlobalId(repo: Repo, n: number): string {
  return b64(`Issue:${repo.id}:${n}`);
}
export function prGlobalId(repo: Repo, n: number): string {
  return b64(`PullRequest:${repo.id}:${n}`);
}

interface ParsedId {
  kind: string;
  repoId: number;
  number: number;
}

export function parseGlobalId(id: string): ParsedId | null {
  try {
    const text = unb64(id);
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const repoId = Number(parts[1]);
    if (!Number.isInteger(repoId)) return null;
    return { kind: parts[0], repoId, number: parts.length > 2 ? Number(parts[2]) : 0 };
  } catch {
    return null;
  }
}

function findRepoById(id: number): Repo | undefined {
  for (const r of store.repos.values()) if (r.id === id) return r;
  return undefined;
}

// --------------------------------------------------------------------------- parser

type Value = string | number | boolean | null | Value[] | { [key: string]: Value } | { __var: string };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, Value>;
  selections: Selection[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = FieldNode | FragmentNode;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, Value>;
  selections: Selection[];
}

interface Token {
  type: 'name' | 'string' | 'number' | 'punct' | 'spread';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.startsWith('...', i)) {
      tokens.push({ type: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$@'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j])) j += 1;
      tokens.push({ type: 'number', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ type: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly fragments: Map<string, Selection[]>;

  constructor(tokens: Token[], fragments: Map<string, Selection[]> = new Map()) {
    this.tokens = tokens;
    this.fragments = fragments;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }

  private expect(value: string): Token {
    const t = this.next();
    if (t.value !== value) throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(t.value)}`);
    return t;
  }

  private skipDirectives(): void {
    while (this.peek()?.value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek()?.value === '(') this.parseValue(); // arguments
    }
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.value === 'fragment') {
        this.next();
        const name = this.next().value;
        this.expect('on');
        this.next(); // type condition
        this.fragments.set(name, this.parseSelectionSet());
        continue;
      }
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const variables: Record<string, Value> = {};
    const t = this.peek()!;
    if (t.value === 'query' || t.value === 'mutation') {
      kind = t.value as 'query' | 'mutation';
      this.next();
      const n = this.peek();
      if (n && n.type === 'name') {
        name = this.next().value;
      }
      if (this.peek()?.value === '(') {
        this.next();
        while (this.peek() && this.peek()!.value !== ')') {
          this.expect('$');
          const varName = this.next().value;
          this.expect(':');
          this.parseType();
          if (this.peek()?.value === '=') {
            this.next();
            variables[varName] = this.parseValue();
          } else {
            variables[varName] = null;
          }
        }
        this.expect(')');
      }
      this.skipDirectives();
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): void {
    // A type reference: Name, [Name], Name!, [Name!]! — consume it without interpreting it.
    let depth = 0;
    for (;;) {
      const t = this.peek();
      if (!t) return;
      if (t.value === '[') {
        depth += 1;
        this.next();
      } else if (t.value === ']') {
        depth -= 1;
        this.next();
        if (depth === 0 && this.peek()?.value === '!') this.next();
        return;
      } else if (t.type === 'name') {
        this.next();
        if (this.peek()?.value === '!') this.next();
        if (depth === 0) return;
      } else if (t.value === '!') {
        this.next();
        if (depth === 0) return;
      } else {
        return;
      }
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() && this.peek()!.value !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): Selection {
    const t = this.peek()!;
    if (t.type === 'spread') {
      this.next();
      const n = this.peek()!;
      if (n.value === 'on') {
        this.next();
        const typeCondition = this.next().value;
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (n.type === 'name') {
        const fragName = this.next().value;
        this.skipDirectives();
        const frag = this.fragments.get(fragName);
        if (!frag) throw new Error(`unknown fragment ${fragName}`);
        return { kind: 'fragment', typeCondition: null, selections: frag };
      }
      this.skipDirectives();
      return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.next();
    if (first.type !== 'name') throw new Error(`expected field name, got ${JSON.stringify(first.value)}`);
    let alias: string | null = null;
    let name = first.value;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args: Record<string, Value> = {};
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek() && this.peek()!.value !== ')') {
        const argName = this.next().value;
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    this.skipDirectives();
    const selections = this.peek()?.value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): Value {
    const t = this.next();
    if (t.value === '$') return { __var: this.next().value };
    if (t.value === '[') {
      const items: Value[] = [];
      while (this.peek() && this.peek()!.value !== ']') items.push(this.parseValue());
      this.expect(']');
      return items;
    }
    if (t.value === '{') {
      const obj: Record<string, Value> = {};
      while (this.peek() && this.peek()!.value !== '}') {
        const key = this.next().value;
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (t.type === 'string') return t.value;
    if (t.type === 'number') return t.value.includes('.') || t.value.includes('e') ? Number(t.value) : Number(t.value);
    if (t.value === 'true') return true;
    if (t.value === 'false') return false;
    if (t.value === 'null') return null;
    return t.value; // bare word: an enum value, kept as a string
  }
}

/** Resolve variables and variable defaults into concrete argument values. */
function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if ('__var' in value) return variables[(value as { __var: string }).__var] ?? null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, variables));
  return value;
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  if (!(name in field.args)) return undefined;
  return resolveValue(field.args[name], variables);
}

// --------------------------------------------------------------------------- resolver

interface GqlCtx {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE';
  fields: string[];
  enumValues: string[];
}

const TYPE_INFO: Record<string, TypeInfo> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'url'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
    enumValues: [],
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'login', 'name', 'email'],
    enumValues: [],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount'],
    enumValues: [],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount'],
    enumValues: [],
  },
  PullRequestFileConnection: {
    kind: 'OBJECT',
    fields: ['nodes', 'edges', 'pageInfo', 'totalCount'],
    enumValues: [],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
    enumValues: [],
  },
  BranchRef: {
    kind: 'OBJECT',
    fields: ['name', 'target'],
    enumValues: [],
  },
  PullRequestFile: {
    kind: 'OBJECT',
    fields: ['path'],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'WIKI', 'PACKAGE', 'MILESTONE'],
  },
};

function unknownField(ctx: GqlCtx, typeName: string, field: FieldNode): null {
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
  return null;
}

/** Cursor for connection pagination: base64url of `cursor:<number>`. */
function cursorFor(n: number): string {
  return b64(`cursor:${n}`);
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = unb64(cursor);
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice(7));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

interface PageArgs {
  first?: number;
  after?: unknown;
  states?: string[];
  orderDesc?: boolean;
}

function pageArgs(field: FieldNode, ctx: GqlCtx): PageArgs {
  const first = argValue(field, 'first', ctx.variables);
  const after = argValue(field, 'after', ctx.variables);
  const states = argValue(field, 'states', ctx.variables);
  const orderBy = argValue(field, 'orderBy', ctx.variables);
  let orderDesc = false;
  if (orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
    const dir = (orderBy as Record<string, unknown>).direction;
    orderDesc = dir === 'DESC';
  }
  return {
    first: typeof first === 'number' ? first : undefined,
    after,
    states: Array.isArray(states) ? (states as string[]) : undefined,
    orderDesc,
  };
}

/** Paginate a list of items keyed by number, honouring first/after and sort direction. */
function paginateByNumber<T extends { number: number }>(
  items: T[],
  args: PageArgs,
): { nodes: T[]; hasNextPage: boolean; endCursor: string | null } {
  const sorted = [...items].sort((a, b) => (args.orderDesc ? b.number - a.number : a.number - b.number));
  const afterN = cursorNumber(args.after);
  let rest = sorted;
  if (afterN !== null) {
    const idx = sorted.findIndex((i) => i.number === afterN);
    rest = idx >= 0 ? sorted.slice(idx + 1) : sorted;
  }
  const first = args.first ?? rest.length;
  const nodes = rest.slice(0, first);
  return {
    nodes,
    hasNextPage: rest.length > first,
    endCursor: nodes.length > 0 ? cursorFor(nodes[nodes.length - 1].number) : null,
  };
}

function resolveSelections(typeName: string, obj: unknown, selections: Selection[], ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition !== null && sel.typeCondition !== typeName) continue;
      Object.assign(out, resolveSelections(typeName, obj, sel.selections, ctx));
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    out[key] = resolveField(typeName, obj, sel, ctx);
  }
  return out;
}

function resolveField(typeName: string, obj: unknown, field: FieldNode, ctx: GqlCtx): unknown {
  const sel = field.selections;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') {
        return resolveSelections('User', { login: store.viewerLogin }, sel, ctx);
      }
      if (field.name === 'repository') {
        const owner = argValue(field, 'owner', ctx.variables);
        const name = argValue(field, 'name', ctx.variables);
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        const resolved = store.resolveOwner(owner);
        if (resolved === null) return null;
        const repo = store.getRepo(resolved, name);
        if (!repo) return null;
        return resolveSelections('Repository', repo, sel, ctx);
      }
      if (field.name === 'node') {
        const id = argValue(field, 'id', ctx.variables);
        if (typeof id !== 'string') return null;
        const parsed = parseGlobalId(id);
        if (!parsed) return null;
        const repo = findRepoById(parsed.repoId);
        if (!repo) return null;
        if (parsed.kind === 'Repository') return resolveSelections('Repository', repo, sel, ctx);
        if (parsed.kind === 'Issue') {
          const issue = repo.issues.get(parsed.number);
          if (!issue) return null;
          return resolveSelections('Issue', { repo, issue }, sel, ctx);
        }
        if (parsed.kind === 'PullRequest') {
          const pr = repo.prs.get(parsed.number);
          if (!pr) return null;
          return resolveSelections('PullRequest', { repo, pr }, sel, ctx);
        }
        return null;
      }
      if (field.name === '__type') {
        const typeNameArg = argValue(field, 'name', ctx.variables);
        if (typeof typeNameArg !== 'string') return null;
        const info = TYPE_INFO[typeNameArg];
        if (!info) return null;
        return resolveSelections('__Type', { name: typeNameArg, info }, sel, ctx);
      }
      return unknownField(ctx, 'Query', field);
    }
    case 'Mutation': {
      if (field.name === 'createIssue') return mutateCreateIssue(obj, field, ctx, sel);
      if (field.name === 'closeIssue') return mutateCloseIssue(field, ctx, sel);
      if (field.name === 'createPullRequest') return mutateCreatePullRequest(field, ctx, sel);
      if (field.name === 'mergePullRequest') return mutateMergePullRequest(field, ctx, sel);
      if (field.name === 'addComment') return mutateAddComment(field, ctx, sel);
      return unknownField(ctx, 'Mutation', field);
    }
    case 'User': {
      const user = obj as { login: string };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return b64(`User:${user.login}`);
      if (field.name === 'name') return user.login;
      if (field.name === 'email') return `${user.login}@example.invalid`;
      return unknownField(ctx, 'User', field);
    }
    case 'Repository': {
      const repo = obj as Repo;
      if (field.name === 'id') return repoGlobalId(repo);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return resolveSelections('User', { login: repo.owner }, sel, ctx);
      if (field.name === 'defaultBranchRef') return resolveSelections('BranchRef', { name: repo.defaultBranch }, sel, ctx);
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'issue') {
        const number = argValue(field, 'number', ctx.variables);
        const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
        if (!issue) return null;
        return resolveSelections('Issue', { repo, issue }, sel, ctx);
      }
      if (field.name === 'issues') {
        const args = pageArgs(field, ctx);
        let issues = [...repo.issues.values()];
        if (args.states) {
          const wanted = new Set(args.states.map((s) => s.toLowerCase()));
          issues = issues.filter((i) => wanted.has(i.state));
        }
        const page = paginateByNumber(issues, args);
        return resolveSelections('IssueConnection', { repo, nodes: page.nodes, hasNextPage: page.hasNextPage, endCursor: page.endCursor }, sel, ctx);
      }
      if (field.name === 'pullRequests') {
        const args = pageArgs(field, ctx);
        let prs = [...repo.prs.values()];
        if (args.states) {
          const wanted = new Set(args.states.map((s) => s.toLowerCase()));
          prs = prs.filter((p) => wanted.has(p.state === 'open' ? 'open' : 'closed'));
        }
        const page = paginateByNumber(prs, args);
        return resolveSelections('PullRequestConnection', { repo, nodes: page.nodes, hasNextPage: page.hasNextPage, endCursor: page.endCursor }, sel, ctx);
      }
      if (field.name === 'pullRequest') {
        const number = argValue(field, 'number', ctx.variables);
        const pr = typeof number === 'number' ? repo.prs.get(number) : undefined;
        if (!pr) return null;
        return resolveSelections('PullRequest', { repo, pr }, sel, ctx);
      }
      return unknownField(ctx, 'Repository', field);
    }
    case 'Issue': {
      const { repo, issue } = obj as { repo: Repo; issue: Issue };
      if (field.name === 'id') return issueGlobalId(repo, issue.number);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state.toUpperCase();
      if (field.name === 'body') return issue.body;
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field.name === 'createdAt') return issue.created_at;
      if (field.name === 'updatedAt') return issue.updated_at;
      if (field.name === 'author') return resolveSelections('User', { login: issue.user }, sel, ctx);
      if (field.name === 'labels') return resolveSelections('LabelConnection', { labels: issue.labels }, sel, ctx);
      if (field.name === 'comments') return resolveSelections('IssueCommentConnection', { comments: issue.comments }, sel, ctx);
      return unknownField(ctx, 'Issue', field);
    }
    case 'PullRequest': {
      const { repo, pr } = obj as { repo: Repo; pr: PullRequest };
      if (field.name === 'id') return prGlobalId(repo, pr.number);
      if (field.name === 'number') return pr.number;
      if (field.name === 'title') return pr.title;
      if (field.name === 'state') return pr.state.toUpperCase();
      if (field.name === 'merged') return pr.merged;
      if (field.name === 'headRefName') return pr.headRef;
      if (field.name === 'baseRefName') return pr.baseRef;
      if (field.name === 'body') return pr.body;
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`;
      if (field.name === 'mergeable') {
        if (pr.state !== 'open') return 'UNKNOWN';
        const mergeable = prMergeable(repo, pr);
        if (mergeable === null) return 'UNKNOWN';
        return mergeable ? 'MERGEABLE' : 'CONFLICTING';
      }
      if (field.name === 'files') {
        const args = pageArgs(field, ctx);
        const { headSha, baseSha } = liveTips(repo, pr);
        const mb = mergeBase(repo, baseSha, headSha);
        const base = mb ? flattenTree(repo, parseCommit(repo.objects.get(mb)!.data).tree) : new Map<string, { oid: string; mode: string }>();
        const head = flattenTree(repo, parseCommit(repo.objects.get(headSha)!.data).tree);
        const paths = [...new Set([...base.keys(), ...head.keys()])]
          .filter((p) => base.get(p)?.oid !== head.get(p)?.oid)
          .sort()
          .map((p) => ({ path: p }));
        const nodes = args.first !== undefined ? paths.slice(0, args.first) : paths;
        return resolveSelections('PullRequestFileConnection', { nodes, hasNextPage: paths.length > nodes.length, endCursor: null }, sel, ctx);
      }
      return unknownField(ctx, 'PullRequest', field);
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      const conn = obj as { repo: Repo; nodes: Array<Issue | PullRequest>; hasNextPage: boolean; endCursor: string | null };
      const itemType = typeName === 'IssueConnection' ? 'Issue' : 'PullRequest';
      if (field.name === 'nodes') {
        return conn.nodes.map((item) =>
          resolveSelections(itemType, { repo: conn.repo, [itemType === 'Issue' ? 'issue' : 'pr']: item }, sel, ctx),
        );
      }
      if (field.name === 'edges') {
        return conn.nodes.map((item) => ({
          node: resolveSelections(itemType, { repo: conn.repo, [itemType === 'Issue' ? 'issue' : 'pr']: item }, sel, ctx),
          cursor: cursorFor(item.number),
        }));
      }
      if (field.name === 'pageInfo') {
        return resolveSelections('PageInfo', { hasNextPage: conn.hasNextPage, endCursor: conn.endCursor }, sel, ctx);
      }
      if (field.name === 'totalCount') return conn.nodes.length;
      return unknownField(ctx, typeName, field);
    }
    case 'PullRequestFileConnection': {
      const conn = obj as { nodes: Array<{ path: string }>; hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'nodes') return conn.nodes.map((f) => resolveSelections('PullRequestFile', f, sel, ctx));
      if (field.name === 'edges') return conn.nodes.map((f) => ({ node: resolveSelections('PullRequestFile', f, sel, ctx), cursor: '' }));
      if (field.name === 'pageInfo') return resolveSelections('PageInfo', { hasNextPage: conn.hasNextPage, endCursor: conn.endCursor }, sel, ctx);
      if (field.name === 'totalCount') return conn.nodes.length;
      return unknownField(ctx, 'PullRequestFileConnection', field);
    }
    case 'PullRequestFile': {
      if (field.name === 'path') return (obj as { path: string }).path;
      return unknownField(ctx, 'PullRequestFile', field);
    }
    case 'PageInfo': {
      const p = obj as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return p.hasNextPage;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      if (field.name === 'endCursor') return p.endCursor;
      return unknownField(ctx, 'PageInfo', field);
    }
    case 'BranchRef': {
      if (field.name === 'name') return (obj as { name: string }).name;
      if (field.name === 'target') return null;
      return unknownField(ctx, 'BranchRef', field);
    }
    case 'LabelConnection': {
      const labels = (obj as { labels: Array<{ name: string }> }).labels;
      if (field.name === 'nodes') return labels.map((l) => ({ name: l.name }));
      if (field.name === 'totalCount') return labels.length;
      return unknownField(ctx, 'LabelConnection', field);
    }
    case 'IssueCommentConnection': {
      const comments = (obj as { comments: Array<{ id: number; body: string }> }).comments;
      if (field.name === 'nodes') return comments.map((c) => ({ id: b64(`IssueComment:${c.id}`), body: c.body }));
      if (field.name === 'totalCount') return comments.length;
      return unknownField(ctx, 'IssueCommentConnection', field);
    }
    case '__Type': {
      const t = obj as { name: string; info: TypeInfo };
      if (field.name === 'name') return t.name;
      if (field.name === 'kind') return t.info.kind;
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        return t.info.fields.map((f) => resolveSelections('__Field', { name: f }, sel, ctx));
      }
      if (field.name === 'enumValues') {
        return t.info.enumValues.map((v) => resolveSelections('__EnumValue', { name: v }, sel, ctx));
      }
      return unknownField(ctx, '__Type', field);
    }
    case '__Field': {
      if (field.name === 'name') return (obj as { name: string }).name;
      if (field.name === 'description') return null;
      if (field.name === 'type') return resolveSelections('__TypeRef', { name: 'String', kind: 'SCALAR' }, sel, ctx);
      if (field.name === 'args') return [];
      return unknownField(ctx, '__Field', field);
    }
    case '__EnumValue': {
      if (field.name === 'name') return (obj as { name: string }).name;
      if (field.name === 'description') return null;
      return unknownField(ctx, '__EnumValue', field);
    }
    case '__TypeRef': {
      if (field.name === 'name') return (obj as { name: string }).name;
      if (field.name === 'kind') return (obj as { kind: string }).kind;
      return unknownField(ctx, '__TypeRef', field);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') {
        const { repo, issue } = obj as { repo: Repo; issue: Issue };
        return resolveSelections('Issue', { repo, issue }, sel, ctx);
      }
      return unknownField(ctx, typeName, field);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') {
        const { repo, pr } = obj as { repo: Repo; pr: PullRequest };
        return resolveSelections('PullRequest', { repo, pr }, sel, ctx);
      }
      return unknownField(ctx, typeName, field);
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') {
        const { comment } = obj as { comment: { id: string; body: string } };
        return resolveSelections('AddCommentEdge', { comment }, sel, ctx);
      }
      return unknownField(ctx, typeName, field);
    }
    case 'AddCommentEdge': {
      if (field.name === 'node') {
        const { comment } = obj as { comment: { id: string; body: string } };
        return resolveSelections('IssueComment', comment, sel, ctx);
      }
      return unknownField(ctx, typeName, field);
    }
    case 'IssueComment': {
      if (field.name === 'id') return (obj as { id: string }).id;
      if (field.name === 'body') return (obj as { body: string }).body;
      return unknownField(ctx, 'IssueComment', field);
    }
    default:
      return unknownField(ctx, typeName, field);
  }
}

// --------------------------------------------------------------------------- mutations

function inputOf(field: FieldNode, ctx: GqlCtx): Record<string, unknown> {
  const input = argValue(field, 'input', ctx.variables);
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function mutateCreateIssue(_obj: unknown, field: FieldNode, ctx: GqlCtx, sel: Selection[]): unknown {
  const input = inputOf(field, ctx);
  const repoId = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
  const repo = repoId ? findRepoById(repoId.repoId) : undefined;
  if (!repo || typeof input.title !== 'string') {
    ctx.errors.push({ message: 'createIssue: repository not found' });
    return { issue: null };
  }
  const number = store.nextNumber(repo);
  const issue: Issue = {
    number,
    id: repo.id * 1_000_000 + number,
    title: input.title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    user: store.viewerLogin,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    closed_at: null,
    comments: [],
  };
  repo.issues.set(number, issue);
  return resolveSelections('CreateIssuePayload', { repo, issue }, sel, ctx);
}

function mutateCloseIssue(field: FieldNode, ctx: GqlCtx, sel: Selection[]): unknown {
  const input = inputOf(field, ctx);
  const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
  const repo = parsed ? findRepoById(parsed.repoId) : undefined;
  const issue = repo && parsed ? repo.issues.get(parsed.number) : undefined;
  if (!issue || !repo) {
    ctx.errors.push({ message: 'closeIssue: issue not found' });
    return { issue: null };
  }
  issue.state = 'closed';
  issue.closed_at = FIXED_DATE;
  return resolveSelections('CloseIssuePayload', { repo, issue }, sel, ctx);
}

function mutateCreatePullRequest(field: FieldNode, ctx: GqlCtx, sel: Selection[]): unknown {
  const input = inputOf(field, ctx);
  const repoId = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
  const repo = repoId ? findRepoById(repoId.repoId) : undefined;
  const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
  const title = typeof input.title === 'string' ? input.title : '';
  if (!repo || !baseRef || !headRef || !title) {
    ctx.errors.push({ message: 'createPullRequest: repository or refs not found' });
    return { pullRequest: null };
  }
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headSha || !baseSha) {
    ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist' });
    return { pullRequest: null };
  }
  const existing = [...repo.prs.values()].find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
  if (existing) return resolveSelections('CreatePullRequestPayload', { repo, pr: existing }, sel, ctx);
  const number = store.nextNumber(repo);
  const pr: PullRequest = {
    number,
    id: repo.id * 1_000_000 + number,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    headRef,
    headSha,
    baseRef,
    baseSha,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    user: store.viewerLogin,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
  repo.prs.set(number, pr);
  return resolveSelections('CreatePullRequestPayload', { repo, pr }, sel, ctx);
}

function mutateMergePullRequest(field: FieldNode, ctx: GqlCtx, sel: Selection[]): unknown {
  const input = inputOf(field, ctx);
  const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
  const repo = parsed ? findRepoById(parsed.repoId) : undefined;
  const pr = repo && parsed ? repo.prs.get(parsed.number) : undefined;
  if (!pr || !repo) {
    ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
    return { pullRequest: null };
  }
  if (pr.state !== 'open') {
    ctx.errors.push({ message: 'mergePullRequest: pull request is already closed' });
    return { pullRequest: null };
  }
  const mergeSha = squashMerge(repo, pr);
  if (mergeSha === null) {
    ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
    return { pullRequest: null };
  }
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = FIXED_DATE;
  pr.merge_commit_sha = mergeSha;
  return resolveSelections('MergePullRequestPayload', { repo, pr }, sel, ctx);
}

function mutateAddComment(field: FieldNode, ctx: GqlCtx, sel: Selection[]): unknown {
  const input = inputOf(field, ctx);
  const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
  const repo = parsed ? findRepoById(parsed.repoId) : undefined;
  const body = typeof input.body === 'string' ? input.body : '';
  if (!repo || !parsed || body === '') {
    ctx.errors.push({ message: 'addComment: subject not found' });
    return { commentEdge: null };
  }
  const commentId = repo.nextCommentId;
  repo.nextCommentId += 1;
  const comment = { id: commentId, body, user: store.viewerLogin, created_at: FIXED_DATE, updated_at: FIXED_DATE };
  if (parsed.kind === 'Issue') {
    repo.issues.get(parsed.number)?.comments.push(comment);
  }
  const node = { id: b64(`IssueComment:${repo.id}:${commentId}`), body };
  return resolveSelections('AddCommentPayload', { comment: node }, sel, ctx);
}

// --------------------------------------------------------------------------- entry point

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string }>;
}

function executeOne(query: string, variables: Record<string, unknown>, operationName?: string): GraphQLResult {
  const ctx: GqlCtx = { variables, errors: [] };
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  let op = operations[0];
  if (operationName) {
    op = operations.find((o) => o.name === operationName) ?? op;
  }
  if (!op) return { data: null, errors: [{ message: 'no operation in document' }] };
  // Merge operation-level variable defaults under the caller's variables.
  const vars: Record<string, unknown> = { ...op.variables };
  for (const [k, v] of Object.entries(variables)) vars[k] = resolveValue(v as Value, variables);
  ctx.variables = vars;
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelections(rootType, null, op.selections, ctx);
  return { data, errors: ctx.errors };
}

/** Run one operation or a batch; returns the response body (object or array). */
export function handleGraphQL(body: unknown): Record<string, unknown> | Array<Record<string, unknown>> {
  if (Array.isArray(body)) {
    return body.map((entry) => {
      if (entry === null || typeof entry !== 'object') return { data: null, errors: [{ message: 'invalid operation' }] };
      const e = entry as Record<string, unknown>;
      const result = executeOne(
        typeof e.query === 'string' ? e.query : '',
        (e.variables ?? {}) as Record<string, unknown>,
        typeof e.operationName === 'string' ? e.operationName : undefined,
      );
      return result.errors.length > 0 ? result : { data: result.data };
    });
  }
  if (body === null || typeof body !== 'object') return { data: null, errors: [{ message: 'invalid operation' }] };
  const e = body as Record<string, unknown>;
  const result = executeOne(
    typeof e.query === 'string' ? e.query : '',
    (e.variables ?? {}) as Record<string, unknown>,
    typeof e.operationName === 'string' ? e.operationName : undefined,
  );
  return result.errors.length > 0 ? result : { data: result.data };
}
