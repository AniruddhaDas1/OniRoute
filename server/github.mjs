export const MAX_REPO_FILES = 80;
export const MAX_FILE_BYTES = 100_000;
const FETCH_TIMEOUT_MS = 20_000;

const SUPPORTED_FILE = /\.(md|mdx|txt|rst|adoc|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|c|h|cpp|hpp|sql|sh|toml|ini|cfg|json|yml|yaml)$/i;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;

function githubHeaders() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'OniRoute-Local' };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function parseRepoUrl(url) {
  const match = url.trim().match(
    /^https:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/?#]+)((?:\/[^?#]*)?))?\/?$/i,
  );
  if (!match) throw new Error('Repository sources must be a public https://github.com/owner/repository URL.');
  const [, owner, repo, branch, rawPath] = match;
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') {
    throw new Error('Invalid GitHub repository format.');
  }
  const subPath = (rawPath ?? '').replace(/^\/+|\/+$/g, '');
  if (subPath.split('/').includes('..')) throw new Error('Path cannot contain "..".');
  return { owner, repo, branch: branch || undefined, subPath };
}

async function githubJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: githubHeaders(), signal: controller.signal });
    if (!res.ok) throw new Error(`GitHub API error (${res.status})`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function sourceFromGitHub(url) {
  const { owner, repo, branch: requestedBranch, subPath } = parseRepoUrl(url);
  const warnings = [];

  let branch = requestedBranch;
  if (!branch) {
    const meta = await githubJson(`https://api.github.com/repos/${owner}/${repo}`);
    branch = String(meta.default_branch || 'HEAD');
  }

  const tree = await githubJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const blobs = (tree.tree || []).filter((entry) => entry.type === 'blob');
  const scoped = subPath ? blobs.filter((entry) => entry.path.startsWith(`${subPath}/`) || entry.path === subPath) : blobs;
  const eligible = scoped.filter((entry) => SUPPORTED_FILE.test(entry.path) && (entry.size ?? 0) < MAX_FILE_BYTES);
  const selected = eligible.slice(0, MAX_REPO_FILES);

  if (!selected.length) throw new Error('No eligible text files found.');

  const encodedPath = (p) => p.split('/').map(encodeURIComponent).join('/');
  const fetched = await Promise.all(
    selected.map(async (entry) => {
      try {
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${encodedPath(entry.path)}`;
        const res = await fetch(rawUrl, { headers: { 'User-Agent': 'OniRoute' } });
        if (!res.ok) return null;
        const text = await res.text();
        if (text.includes('\u0000')) return null;
        return `FILE: ${entry.path}\n${text}`;
      } catch {
        return null;
      }
    }),
  );

  const pieces = fetched.filter(Boolean);
  return {
    content: pieces.join('\n\n'),
    filesRead: pieces.length,
    filesSkipped: selected.length - pieces.length,
    warnings,
  };
}
