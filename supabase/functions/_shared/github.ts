import { fetchWithTimeout, mapWithConcurrency } from './runtime.ts';

export interface RepoSource {
  content: string;
  filesRead: number;
  filesSkipped: number;
  warnings: string[];
}

export const MAX_REPO_FILES = 80;
export const MAX_FILE_BYTES = 100_000;
const FETCH_TIMEOUT_MS = 20_000;
const RAW_CONCURRENCY = 8;

const SUPPORTED_FILE = /\.(md|mdx|txt|rst|adoc|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|c|h|cpp|hpp|sql|sh|toml|ini|cfg|json|yml|yaml)$/i;

// GitHub logins are alphanumeric with internal hyphens; repository names allow
// dots and underscores. Anchoring both is what keeps a crafted `..` segment
// from walking the API path somewhere else.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'OniRoute' };
  // Anonymous GitHub API access is 60 requests/hour per IP, shared across every
  // function on the Edge host. A token raises that to 5,000 and is the
  // difference between ingestion working and not.
  const token = Deno.env.get('GITHUB_TOKEN');
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Accepts a whole repository, or a subtree:
 *
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/main/docs
 *
 * The subtree form matters for large repositories. Ingestion keeps the first
 * `MAX_REPO_FILES` eligible files in tree order, so pointing at the repository
 * root of something like `flutter/website` yields 80 files of CI config rather
 * than 80 files of documentation. Narrowing to the docs directory is the
 * difference between a useful index and a useless one.
 */
function parseRepoUrl(url: string): { owner: string; repo: string; branch?: string; subPath: string } {
  const match = url.trim().match(
    /^https:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/?#]+)((?:\/[^?#]*)?))?\/?$/i,
  );
  if (!match) throw new Error('Repository sources must be a public https://github.com/owner/repository URL.');
  const [, owner, repo, branch, rawPath] = match;
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') {
    throw new Error('That does not look like a valid GitHub owner/repository pair.');
  }
  const subPath = (rawPath ?? '').replace(/^\/+|\/+$/g, '');
  // A `..` segment here would let a crafted URL walk out of the subtree.
  if (subPath.split('/').includes('..')) throw new Error('Repository paths may not contain "..".');
  return { owner, repo, branch: branch || undefined, subPath };
}

async function githubJson(url: string, what: string): Promise<any> {
  const response = await fetchWithTimeout(url, { headers: githubHeaders() }, FETCH_TIMEOUT_MS);
  if (response.ok) return await response.json();

  const remaining = response.headers.get('x-ratelimit-remaining');
  if ((response.status === 403 || response.status === 429) && remaining === '0') {
    throw new Error(
      'GitHub rate limit reached. Set a GITHUB_TOKEN secret on the embed-knowledge function ' +
        '(`supabase secrets set GITHUB_TOKEN=…`) to raise the limit from 60 to 5,000 requests per hour.',
    );
  }
  if (response.status === 404) throw new Error(`${what} was not found. Only public repositories can be ingested.`);
  throw new Error(`${what} could not be read (${response.status}).`);
}

/**
 * Read a public repository's text files.
 *
 * Two calls hit the rate-limited REST API (repository metadata, then the
 * recursive tree); the file bodies come from raw.githubusercontent.com, which
 * is a CDN with far higher limits. The previous implementation issued one REST
 * `contents` call per file — up to 80 — which exhausted the anonymous quota
 * almost immediately and made repository ingestion fail in practice.
 */
export async function sourceFromGitHub(url: string): Promise<RepoSource> {
  const { owner, repo, branch: requestedBranch, subPath } = parseRepoUrl(url);
  const warnings: string[] = [];

  let branch: string = requestedBranch ?? '';
  if (!branch) {
    const meta = await githubJson(`https://api.github.com/repos/${owner}/${repo}`, 'Repository');
    branch = String(meta.default_branch || 'HEAD');
  }

  const tree = await githubJson(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    'Repository tree',
  );
  if (tree.truncated) {
    warnings.push('The repository tree was too large for GitHub to return in full; some files were not considered.');
  }

  const blobs = (tree.tree as TreeEntry[] | undefined ?? []).filter((entry) => entry.type === 'blob');
  const scoped = subPath ? blobs.filter((entry) => entry.path.startsWith(`${subPath}/`) || entry.path === subPath) : blobs;
  if (subPath && !scoped.length) {
    throw new Error(`No files were found under "${subPath}" on branch "${branch}".`);
  }
  const eligible = scoped.filter((entry) => SUPPORTED_FILE.test(entry.path) && (entry.size ?? 0) < MAX_FILE_BYTES);
  const selected = eligible.slice(0, MAX_REPO_FILES);
  if (eligible.length > MAX_REPO_FILES) {
    warnings.push(
      `${eligible.length} supported files found${subPath ? ` under ${subPath}` : ''}; ingestion is capped at ${MAX_REPO_FILES}. ` +
        'Narrow the URL to a subdirectory (…/tree/BRANCH/path) to control which files are indexed.',
    );
  }
  if (!selected.length) throw new Error('No supported text files under 100 KB were found in this repository.');

  const encodedPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');
  const fetched = await mapWithConcurrency(selected, RAW_CONCURRENCY, async (entry) => {
    try {
      const response = await fetchWithTimeout(
        `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${encodedPath(entry.path)}`,
        { headers: { 'User-Agent': 'OniRoute' } },
        FETCH_TIMEOUT_MS,
      );
      if (!response.ok) return null;
      const text = await response.text();
      // A NUL byte means this decoded as binary, not source.
      if (text.includes('\u0000')) return null;
      return `FILE: ${entry.path}\n${text}`;
    } catch {
      return null;
    }
  });

  const pieces = fetched.filter((piece): piece is string => piece !== null);
  if (!pieces.length) throw new Error('None of the selected repository files could be downloaded.');
  const skipped = selected.length - pieces.length;
  if (skipped > 0) warnings.push(`${skipped} file(s) could not be downloaded and were skipped.`);

  return { content: pieces.join('\n\n'), filesRead: pieces.length, filesSkipped: skipped, warnings };
}
