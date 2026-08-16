// Seed OniRoute with a curated set of coding-knowledge sources.
//
//   node scripts/seed-knowledge.mjs --check           # validate the catalog only, create nothing
//   node scripts/seed-knowledge.mjs                   # create the knowledge bases
//   node scripts/seed-knowledge.mjs --ingest          # create, then queue ingestion and watch it
//   node scripts/seed-knowledge.mjs --only react,flutter
//
// Requires in .env (or the environment):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY   — already there for the dashboard
//   ONIROUTE_EMAIL, ONIROUTE_PASSWORD           — a dashboard account to seed into
//   GITHUB_TOKEN                                — optional; raises 60/hr to 5,000/hr
//   ONIROUTE_EMBEDDING_PROVIDER                 — optional provider UUID; otherwise the
//                                                 first provider with an embedding model
//
// Everything goes through the real HTTP API with a real session, so ownership
// and validation behave exactly as they do for the dashboard.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

/**
 * Each entry points at a *subdirectory*, not a repository root.
 *
 * Ingestion keeps the first 80 eligible files in tree order and caps the result
 * at 400 chunks. A repository root would spend that budget on CI config and
 * templates; a docs directory spends it on documentation. `--check` reports the
 * real file count for each entry, because these paths do drift between releases.
 *
 * Licences vary (MIT, Apache-2.0, CC-BY, CC-BY-SA). This builds a private index
 * for your own retrieval — if you redistribute generated output, honour the
 * upstream terms and attribute the source.
 */
const CATALOG = [
  // --- Web fundamentals -----------------------------------------------------
  { slug: 'mdn-js', name: 'MDN — JavaScript guide', url: 'https://github.com/mdn/content/tree/main/files/en-us/web/javascript/guide' },
  { slug: 'mdn-css', name: 'MDN — CSS guide', url: 'https://github.com/mdn/content/tree/main/files/en-us/web/css' },
  { slug: 'mdn-http', name: 'MDN — HTTP guide', url: 'https://github.com/mdn/content/tree/main/files/en-us/web/http/guides' },
  { slug: 'mdn-a11y', name: 'MDN — Accessibility', url: 'https://github.com/mdn/content/tree/main/files/en-us/web/accessibility' },

  // --- Language / typing ----------------------------------------------------
  { slug: 'typescript', name: 'TypeScript handbook', url: 'https://github.com/microsoft/TypeScript-Website/tree/v2/packages/documentation/copy/en/handbook-v2' },
  { slug: 'ts-react', name: 'TypeScript cheatsheets — React', url: 'https://github.com/typescript-cheatsheets/react/tree/main/docs' },

  // --- Web application frameworks ------------------------------------------
  { slug: 'react-learn', name: 'React — Learn', url: 'https://github.com/reactjs/react.dev/tree/main/src/content/learn' },
  { slug: 'react-reference', name: 'React — API reference', url: 'https://github.com/reactjs/react.dev/tree/main/src/content/reference/react' },
  { slug: 'nextjs', name: 'Next.js documentation', url: 'https://github.com/vercel/next.js/tree/canary/docs' },
  { slug: 'vue', name: 'Vue — guide', url: 'https://github.com/vuejs/docs/tree/main/src/guide' },
  { slug: 'svelte', name: 'Svelte — documentation', url: 'https://github.com/sveltejs/svelte/tree/main/documentation/docs' },
  { slug: 'angular', name: 'Angular — guide', url: 'https://github.com/angular/angular/tree/main/adev/src/content/guide' },
  { slug: 'astro', name: 'Astro — documentation', url: 'https://github.com/withastro/docs/tree/main/src/content/docs/en' },
  { slug: 'nuxt', name: 'Nuxt — documentation', url: 'https://github.com/nuxt/nuxt/tree/main/docs' },
  { slug: 'react-router', name: 'React Router — documentation', url: 'https://github.com/remix-run/react-router/tree/main/docs' },

  // --- UI component libraries and design systems ---------------------------
  { slug: 'shadcn', name: 'shadcn/ui — documentation', url: 'https://github.com/shadcn-ui/ui/tree/main/apps/v4/content/docs' },
  { slug: 'mui', name: 'Material UI — components', url: 'https://github.com/mui/material-ui/tree/master/docs/data/material/components' },
  { slug: 'bootstrap', name: 'Bootstrap — documentation', url: 'https://github.com/twbs/bootstrap/tree/main/site/src/content' },
  { slug: 'radix', name: 'Radix UI — primitives', url: 'https://github.com/radix-ui/website/tree/main/data/primitives/docs/components' },
  { slug: 'tailwind', name: 'Tailwind CSS — documentation', url: 'https://github.com/tailwindlabs/tailwindcss.com/tree/main/src/docs' },

  // --- PHP ------------------------------------------------------------------
  // The official PHP manual (php/doc-en) is DocBook XML, which is neither in the
  // ingester's supported extensions nor good retrieval material once chunked.
  // These three cover the language idioms and the two dominant frameworks.
  { slug: 'php-right-way', name: 'PHP — The Right Way', url: 'https://github.com/codeguy/php-the-right-way/tree/gh-pages/_posts' },
  { slug: 'laravel', name: 'Laravel — documentation', url: 'https://github.com/laravel/docs/tree/11.x' },
  { slug: 'symfony', name: 'Symfony — documentation', url: 'https://github.com/symfony/symfony-docs/tree/7.2' },

  // --- Server / backend -----------------------------------------------------
  { slug: 'node-api', name: 'Node.js — API documentation', url: 'https://github.com/nodejs/node/tree/main/doc/api' },
  { slug: 'node-practices', name: 'Node.js best practices', url: 'https://github.com/goldbergyoni/nodebestpractices/tree/master/sections' },
  { slug: 'hono', name: 'Hono — documentation', url: 'https://github.com/honojs/website/tree/main/docs' },

  // --- Mobile ---------------------------------------------------------------
  { slug: 'react-native', name: 'React Native — documentation', url: 'https://github.com/facebook/react-native-website/tree/main/docs' },
  { slug: 'flutter', name: 'Flutter — documentation', url: 'https://github.com/flutter/website/tree/main/sites/docs/src/content' },
  { slug: 'expo', name: 'Expo — guides', url: 'https://github.com/expo/expo/tree/main/docs/pages/guides' },
  { slug: 'ionic', name: 'Ionic — documentation', url: 'https://github.com/ionic-team/ionic-docs/tree/main/docs' },
  { slug: 'maui', name: '.NET MAUI — documentation', url: 'https://github.com/dotnet/docs-maui/tree/main/docs' },
  { slug: 'kmp', name: 'Kotlin Multiplatform — docs', url: 'https://github.com/JetBrains/kotlin-multiplatform-dev-docs/tree/master/topics' },

  // --- Desktop --------------------------------------------------------------
  { slug: 'electron', name: 'Electron — documentation', url: 'https://github.com/electron/electron/tree/main/docs' },
  { slug: 'tauri', name: 'Tauri — documentation', url: 'https://github.com/tauri-apps/tauri-docs/tree/v2/src/content/docs' },

  // --- Platform -------------------------------------------------------------
  { slug: 'supabase', name: 'Supabase — guides', url: 'https://github.com/supabase/supabase/tree/master/apps/docs/content/guides' },

  // --- Agent skills -------------------------------------------------------
  { slug: 'mattpocock-skills', name: 'mattpocock/skills', url: 'https://github.com/mattpocock/skills/tree/main' },
  { slug: 'andrej-karpathy-skills', name: 'andrej-karpathy-skills', url: 'https://github.com/multica-ai/andrej-karpathy-skills/tree/main' },
  { slug: 'impeccable', name: 'impeccable — UI skills', url: 'https://github.com/pbakaus/impeccable/tree/main' },
  { slug: 'taste-skill', name: 'taste-skill', url: 'https://github.com/leonxlnx/taste-skill/tree/main' },
  { slug: 'skillfish', name: 'skillfish', url: 'https://github.com/knoxgraeme/skillfish/tree/main' },
  { slug: 'gstack', name: 'gstack — AI dev skills', url: 'https://github.com/garrytan/gstack/tree/main' },
  { slug: 'vuejs-ai-skills', name: 'vuejs-ai/skills', url: 'https://github.com/vuejs-ai/skills/tree/main' },
  { slug: 'gsd-core', name: 'open-gsd/gsd-core', url: 'https://github.com/open-gsd/gsd-core/tree/main' },
  { slug: 'claude-skills', name: 'claude-skills', url: 'https://github.com/alirezarezvani/claude-skills/tree/main' },
];

const SUPPORTED_FILE = /\.(md|mdx|txt|rst|adoc|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|c|h|cpp|hpp|sql|sh|toml|ini|cfg|json|yml|yaml)$/i;
const MAX_FILE_BYTES = 100_000;
const MAX_REPO_FILES = 80;

function loadEnv() {
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .env file; rely on the ambient environment.
  }
}

function need(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. See the header of this file for what is required.`);
    process.exit(1);
  }
  return value;
}

function parseUrl(url) {
  // The path is optional: a dedicated docs repository (laravel/docs) is already
  // scoped, so it needs no subdirectory.
  const [, owner, repo, branch, path = ''] =
    url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.*))?$/) ?? [];
  if (!owner) throw new Error(`Catalog entry is not a /tree/BRANCH URL: ${url}`);
  return { owner, repo, branch, path: path.replace(/\/$/, '') };
}

const treeCache = new Map();

async function repoTree(owner, repo, branch) {
  const key = `${owner}/${repo}@${branch}`;
  if (treeCache.has(key)) return treeCache.get(key);
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'OniRoute-seed' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, { headers });
  if (!response.ok) {
    const hint = response.headers.get('x-ratelimit-remaining') === '0'
      ? ' (rate limited — set GITHUB_TOKEN)'
      : '';
    throw new Error(`tree ${response.status}${hint}`);
  }
  const tree = await response.json();
  treeCache.set(key, tree);
  return tree;
}

/** Resolve each catalog entry against GitHub so drifted paths surface before anything is created. */
async function checkCatalog(entries) {
  const results = [];
  for (const entry of entries) {
    try {
      const { owner, repo, branch, path } = parseUrl(entry.url);
      const tree = await repoTree(owner, repo, branch);
      const matching = (tree.tree ?? []).filter((node) =>
        node.type === 'blob' &&
        // An empty path means the whole repository is in scope.
        (!path || node.path === path || node.path.startsWith(`${path}/`)) &&
        SUPPORTED_FILE.test(node.path) &&
        (node.size ?? 0) < MAX_FILE_BYTES
      );
      results.push({ entry, files: matching.length, truncated: Boolean(tree.truncated), error: null });
    } catch (error) {
      results.push({ entry, files: 0, truncated: false, error: error.message });
    }
  }
  return results;
}

function report(results) {
  console.log('\n  files  source');
  console.log('  -----  ------------------------------------------------------------');
  for (const { entry, files, error } of results) {
    const count = error ? '  !!!' : String(Math.min(files, MAX_REPO_FILES)).padStart(5);
    const capped = !error && files > MAX_REPO_FILES ? `  (of ${files}, capped at ${MAX_REPO_FILES})` : '';
    console.log(`  ${count}  ${entry.name}${capped}${error ? `  — ${error}` : ''}`);
  }
  const broken = results.filter((result) => result.error || result.files === 0);
  console.log(`\n  ${results.length - broken.length}/${results.length} sources resolved.`);
  if (broken.length) {
    console.log('  Unresolved entries are skipped. Upstream repositories reorganise their');
    console.log('  docs directories; edit CATALOG in this file to correct the paths.\n');
  }
  return results.filter((result) => !result.error && result.files > 0);
}

async function main() {
  loadEnv();
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const withIngest = argv.includes('--ingest');
  const onlyArg = argv.find((arg) => arg.startsWith('--only'));
  const only = onlyArg ? (onlyArg.split('=')[1] ?? argv[argv.indexOf(onlyArg) + 1] ?? '').split(',').filter(Boolean) : [];

  const entries = only.length ? CATALOG.filter((entry) => only.includes(entry.slug)) : CATALOG;
  if (!entries.length) {
    console.error(`No catalog entries matched. Known slugs: ${CATALOG.map((entry) => entry.slug).join(', ')}`);
    process.exit(1);
  }

  console.log(`Checking ${entries.length} source(s) against GitHub…`);
  const usable = report(await checkCatalog(entries));
  if (checkOnly || !usable.length) return;

  const supabaseUrl = need('VITE_SUPABASE_URL');
  const supabase = createClient(supabaseUrl, need('VITE_SUPABASE_ANON_KEY'), { auth: { persistSession: false } });
  const { data: auth, error: authError } = await supabase.auth.signInWithPassword({
    email: need('ONIROUTE_EMAIL'),
    password: need('ONIROUTE_PASSWORD'),
  });
  if (authError) {
    console.error(`Sign-in failed: ${authError.message}`);
    process.exit(1);
  }

  const call = async (path, init = {}) => {
    const response = await fetch(`${supabaseUrl}/functions/v1/api${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.VITE_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${auth.session.access_token}`,
      },
    });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body.data;
  };

  const providers = await call('/providers');
  const provider = process.env.ONIROUTE_EMBEDDING_PROVIDER
    ? providers.find((candidate) => candidate.id === process.env.ONIROUTE_EMBEDDING_PROVIDER)
    : providers.find((candidate) => candidate.embedding_model_name) ?? providers[0];
  if (!provider) {
    console.error('No provider is configured. Add one in the dashboard first — embedding needs a real API key.');
    process.exit(1);
  }
  console.log(`\nEmbedding provider: ${provider.name} (${provider.embedding_model_name ?? provider.model_name})`);
  if (!provider.embedding_model_name) {
    console.log('  Warning: this provider has no embedding model set, so its chat model will be used.');
    console.log('  It must return 1536 dimensions or ingestion will fail.');
  }

  const existing = await call('/knowledge');
  const byName = new Map(existing.map((base) => [base.name, base]));
  const targets = [];

  for (const { entry } of usable) {
    const found = byName.get(entry.name);
    if (found) {
      console.log(`  = ${entry.name} (already present)`);
      targets.push(found);
      continue;
    }
    const created = await call('/knowledge', {
      method: 'POST',
      body: JSON.stringify({
        name: entry.name,
        source_type: 'repo',
        source_url: entry.url,
        embedding_provider_id: provider.id,
      }),
    });
    console.log(`  + ${entry.name}`);
    targets.push(created);
  }

  if (!withIngest) {
    console.log(`\n${targets.length} knowledge base(s) ready. Run with --ingest, or press Ingest in the dashboard.`);
    return;
  }

  console.log(`\nQueueing ingestion for ${targets.length} source(s)…`);
  for (const base of targets) {
    try {
      await call(`/knowledge/${base.id}/ingest`, { method: 'POST', body: JSON.stringify({ embedding_provider_id: provider.id }) });
    } catch (error) {
      console.log(`  ! ${base.name}: ${error.message}`);
    }
  }

  // One job runs at a time per source; poll until nothing is in flight.
  const ids = new Set(targets.map((base) => base.id));
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const bases = (await call('/knowledge')).filter((base) => ids.has(base.id));
    const active = bases.filter((base) => base.status === 'queued' || base.status === 'processing');
    const done = bases.filter((base) => base.status === 'complete');
    const failed = bases.filter((base) => base.status === 'error');
    const chunks = bases.reduce((sum, base) => sum + (base.ingest_stats?.chunks_embedded ?? 0), 0);
    process.stdout.write(`\r  ${done.length} complete, ${active.length} running, ${failed.length} failed — ${chunks} chunks embedded   `);
    if (!active.length) {
      console.log('\n');
      for (const base of failed) console.log(`  ! ${base.name}: ${base.error_message}`);
      for (const base of done) {
        const warnings = base.ingest_stats?.warnings ?? [];
        if (warnings.length) console.log(`  ~ ${base.name}: ${warnings.join(' ')}`);
      }
      console.log(`\nDone. ${done.length} source(s) indexed, ${chunks} chunks total.`);
      return;
    }
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
