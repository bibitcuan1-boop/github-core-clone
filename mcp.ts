// Model Context Protocol over Streamable HTTP (JSON-RPC 2.0, plain application/json
// replies). The modern era (2026-07-28): `server/discover` answers first, so no
// handshake or session is needed; the legacy `initialize` path is kept as a fallback.
// Tools act on the same store as REST and GraphQL, so a repo created here reads back
// identically over REST.

import { FIXED_DATE, store, type Repo } from './store.ts';
import { repoJson, issueJson, prJson } from './rest.ts';
import { squashMerge } from './rest.ts';

export interface McpResponse {
  status: number;
  body: unknown;
  empty?: boolean;
}

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

// One constant definition, so two tools/list calls serialise byte-identically.
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from one branch onto another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
]);

function toolResult(id: unknown, structured: unknown): Record<string, unknown> {
  const text = JSON.stringify(structured);
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], structuredContent: structured } };
}

function toolError(id: unknown, message: string): Record<string, unknown> {
  const structured = { error: message };
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError: true },
  };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function findRepo(owner: string, repo: string): Repo | null {
  const resolved = store.resolveOwner(owner);
  if (resolved === null) return null;
  return store.getRepo(resolved, repo) ?? null;
}

function strArg(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  return typeof v === 'string' ? v : '';
}

function numArg(args: Record<string, unknown>, name: string): number | null {
  const v = args[name];
  return typeof v === 'number' ? v : null;
}

function callTool(name: string, args: Record<string, unknown>, id: unknown): Record<string, unknown> {
  const missing = (tool: ToolDef): string | null => {
    for (const r of tool.inputSchema.required) {
      if (args[r] === undefined || args[r] === null || args[r] === '') return `missing required argument: ${r}`;
    }
    return null;
  };
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
  const miss = missing(tool);
  if (miss) return toolError(id, miss);

  switch (name) {
    case 'create_repo': {
      const repo = store.createRepo(strArg(args, 'name'), {
        description: strArg(args, 'description'),
        private: args.private === true,
      });
      if (!repo) return toolError(id, 'Repository already exists');
      return toolResult(id, repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(strArg(args, 'owner'), strArg(args, 'repo'));
      if (!repo) return toolError(id, 'Repository not found');
      return toolResult(id, repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepo(strArg(args, 'owner'), strArg(args, 'repo'));
      if (!repo) return toolError(id, 'Repository not found');
      const number = store.nextNumber(repo);
      const issue = {
        number,
        id: repo.id * 1_000_000 + number,
        title: strArg(args, 'title'),
        body: strArg(args, 'body'),
        state: 'open' as const,
        labels: [],
        user: store.viewerLogin,
        created_at: FIXED_DATE,
        updated_at: FIXED_DATE,
        closed_at: null,
        comments: [],
      };
      repo.issues.set(number, issue);
      return toolResult(id, issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo(strArg(args, 'owner'), strArg(args, 'repo'));
      if (!repo) return toolError(id, 'Repository not found');
      const state = strArg(args, 'state') || 'open';
      const issues = [...repo.issues.values()]
        .filter((i) => state === 'all' || i.state === state)
        .sort((a, b) => a.number - b.number)
        .map((i) => issueJson(repo, i));
      return toolResult(id, { issues });
    }
    case 'create_pull_request': {
      const repo = findRepo(strArg(args, 'owner'), strArg(args, 'repo'));
      if (!repo) return toolError(id, 'Repository not found');
      const head = strArg(args, 'head');
      const base = strArg(args, 'base');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError(id, 'head or base branch does not exist');
      const existing = [...repo.prs.values()].find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (existing) return toolResult(id, prJson(repo, existing));
      const number = store.nextNumber(repo);
      const pr = {
        number,
        id: repo.id * 1_000_000 + number,
        title: strArg(args, 'title'),
        body: '',
        state: 'open' as const,
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
      return toolResult(id, prJson(repo, pr));
    }
    case 'merge_pull_request': {
      const repo = findRepo(strArg(args, 'owner'), strArg(args, 'repo'));
      if (!repo) return toolError(id, 'Repository not found');
      const pullNumber = numArg(args, 'pull_number');
      const pr = pullNumber !== null ? repo.prs.get(pullNumber) : undefined;
      if (!pr) return toolError(id, 'Pull request not found');
      if (pr.state !== 'open') return toolError(id, 'Pull request is already closed');
      const mergeSha = squashMerge(repo, pr);
      if (mergeSha === null) return toolError(id, 'Merge conflict');
      pr.state = 'closed';
      pr.merged = true;
      pr.merged_at = FIXED_DATE;
      pr.merge_commit_sha = mergeSha;
      return toolResult(id, { merged: true, sha: mergeSha, message: pr.title });
    }
    case 'get_issue': {
      const repo = findRepo(strArg(args, 'owner'), strArg(args, 'repo'));
      if (!repo) return toolError(id, 'Repository not found');
      const n = numArg(args, 'issue_number');
      const issue = n !== null ? repo.issues.get(n) : undefined;
      if (!issue) return toolError(id, 'Issue not found');
      return toolResult(id, issueJson(repo, issue));
    }
    case 'list_repos': {
      const repos = [...store.repos.values()]
        .filter((r) => r.owner === store.viewerLogin)
        .map((r) => repoJson(r));
      return toolResult(id, { repositories: repos });
    }
    default:
      return rpcError(id, -32602, `Unknown tool: ${name}`);
  }
}

/** Handle one POST /mcp exchange. `bodyText` is the raw request body. */
export function handleMcp(bodyText: string): McpResponse {
  let request: unknown;
  try {
    request = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null } };
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { status: 400, body: { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null } };
  }
  const req = request as Record<string, unknown>;
  const id = 'id' in req ? req.id : null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params) ? (req.params as Record<string, unknown>) : {};

  // Notifications (no id) get no reply.
  if (!('id' in req) || req.id === undefined) {
    return { status: 202, body: null, empty: true };
  }

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            supportedVersions: ['2026-07-28', '2025-11-25'],
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
          },
        },
      };
    case 'initialize':
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: { protocolVersion: '2026-07-28', capabilities: { tools: {} }, serverInfo: SERVER_INFO },
        },
      };
    case 'ping':
      return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
    case 'tools/list':
      return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
      return { status: 200, body: callTool(toolName, args, id) };
    }
    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}
