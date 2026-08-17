import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Shield,
  Zap,
  BookOpen,
  Server,
  Layers,
  CheckCircle2,
  Copy,
  Terminal,
  Globe,
} from 'lucide-react';

export default function LandingPage() {
  const [activeTab, setActiveTab] = useState<'curl' | 'python' | 'js'>('curl');
  const [copied, setCopied] = useState(false);

  const snippets = {
    curl: `curl http://localhost:1001/v1/chat/completions \\
  -H "Authorization: Bearer or_your_gateway_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [{"role": "user", "content": "Hello OniRoute!"}],
    "temperature": 0.7
  }'`,
    python: `from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:1001/v1",
    api_key="or_your_gateway_key"
)

response = client.chat.completions.create(
    model="default",
    messages=[{"role": "user", "content": "Hello OniRoute!"}]
)

print(response.choices[0].message.content)`,
    js: `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:1001/v1',
  apiKey: 'or_your_gateway_key',
});

const response = await client.chat.completions.create({
  model: 'default',
  messages: [{ role: 'user', content: 'Hello OniRoute!' }],
});

console.log(response.choices[0].message.content);`,
  };

  const copyCode = async () => {
    await navigator.clipboard.writeText(snippets[activeTab]);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 selection:bg-violet-600 selection:text-white">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-600 font-bold text-white shadow-lg shadow-violet-600/30">
              OR
            </div>
            <span className="text-lg font-bold tracking-tight text-white">OniRoute</span>
            <span className="rounded-full bg-violet-500/10 px-2.5 py-0.5 text-xs font-semibold text-violet-400 border border-violet-500/20">
              v1.1.0 Open Source
            </span>
          </div>

          <div className="flex items-center gap-4">
            <a
              href="https://github.com/AniruddhaDas1"
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-slate-400 transition-colors hover:text-white"
            >
              GitHub
            </a>
            <Link
              to="/login"
              className="text-sm font-medium text-slate-300 transition-colors hover:text-white"
            >
              Sign In
            </Link>
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-md shadow-violet-600/20 transition-all hover:bg-violet-500 hover:shadow-violet-600/40"
            >
              Launch App <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative overflow-hidden px-6 pt-20 pb-24 text-center">
        <div className="mx-auto max-w-4xl space-y-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-950/40 px-3.5 py-1 text-xs font-medium text-violet-300">
            <Zap className="h-3.5 w-3.5 text-violet-400" />
            Unified OpenAI Gateway · Automatic Failover · Private RAG
          </div>

          <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-6xl sm:leading-tight">
            One AI Gateway to Route <br />
            <span className="text-violet-400">All Your LLM Providers</span>
          </h1>

          <p className="mx-auto max-w-2xl text-lg text-slate-400 sm:text-xl">
            Plug in your OpenAI, Anthropic, Google Gemini, and custom API keys once. Call a single OpenAI-compatible
            endpoint with automatic failover, audit logs, and private knowledge retrieval.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-4 pt-4">
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-6 py-3 text-base font-semibold text-white shadow-lg shadow-violet-600/30 transition-all hover:bg-violet-500 hover:shadow-violet-600/50"
            >
              Open Dashboard <ArrowRight className="h-5 w-5" />
            </Link>
            <a
              href="#code-snippet"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-6 py-3 text-base font-medium text-slate-300 transition-colors hover:border-slate-600 hover:bg-slate-800 hover:text-white"
            >
              <Terminal className="h-5 w-5 text-slate-400" /> Quick API Example
            </a>
          </div>
        </div>
      </section>

      {/* Code Snippet Switcher */}
      <section id="code-snippet" className="mx-auto max-w-4xl px-6 pb-24">
        <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/60 px-4 py-3">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setActiveTab('curl')}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  activeTab === 'curl'
                    ? 'bg-violet-600 text-white'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                }`}
              >
                cURL
              </button>
              <button
                onClick={() => setActiveTab('python')}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  activeTab === 'python'
                    ? 'bg-violet-600 text-white'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                }`}
              >
                Python
              </button>
              <button
                onClick={() => setActiveTab('js')}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                  activeTab === 'js'
                    ? 'bg-violet-600 text-white'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                }`}
              >
                TypeScript / Node
              </button>
            </div>

            <button
              onClick={copyCode}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 hover:text-white"
            >
              {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <pre className="overflow-x-auto p-5 font-mono text-sm leading-relaxed text-slate-300">
            {snippets[activeTab]}
          </pre>
        </div>
      </section>

      {/* Feature Highlights Grid */}
      <section className="border-t border-slate-800/80 bg-slate-900/40 px-6 py-20">
        <div className="mx-auto max-w-6xl space-y-12">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Engineered for Speed, Reliability & Security
            </h2>
            <p className="mt-3 text-base text-slate-400">
              Everything you need to orchestrate and safeguard your AI stack in production or locally.
            </p>
          </div>

          <div className="grid gap-8 md:grid-cols-3">
            <div className="rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-sm">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-600/10 text-violet-400 border border-violet-500/20">
                <Zap className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white">Smart Failover & Routing</h3>
              <p className="mt-2 text-sm text-slate-400 leading-relaxed">
                If OpenAI experiences a 429 rate limit or outage, OniRoute instantly retries with Anthropic or Gemini
                without dropping client requests.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-sm">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-600/10 text-violet-400 border border-violet-500/20">
                <Shield className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white">Encrypted Key Vault</h3>
              <p className="mt-2 text-sm text-slate-400 leading-relaxed">
                Your upstream AI keys never touch browser code or logs. Protected by Supabase Vault in the cloud and
                AES-256-GCM encryption locally.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-sm">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-600/10 text-violet-400 border border-violet-500/20">
                <BookOpen className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white">Private Vector RAG</h3>
              <p className="mt-2 text-sm text-slate-400 leading-relaxed">
                Ingest GitHub documentation or custom text. Responses are augmented with sub-millisecond semantic search
                using pgvector and in-memory cosine engines.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-sm">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-600/10 text-violet-400 border border-violet-500/20">
                <Server className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white">Permanent Local Server (Port 1001)</h3>
              <p className="mt-2 text-sm text-slate-400 leading-relaxed">
                Run standalone with zero Docker or cloud accounts via <code className="text-violet-300">npm run local</code>.
                Perfect for offline workflows and local development.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-sm">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-600/10 text-violet-400 border border-violet-500/20">
                <Layers className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white">Audit Logs & Token Accounting</h3>
              <p className="mt-2 text-sm text-slate-400 leading-relaxed">
                Monitor request latency, failover trails, and exact prompt & completion token consumption across all
                models in real-time.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-sm">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-violet-600/10 text-violet-400 border border-violet-500/20">
                <Globe className="h-6 w-6" />
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white">Universal Client Support</h3>
              <p className="mt-2 text-sm text-slate-400 leading-relaxed">
                Seamlessly connects to Cursor, Continue.dev, Cline, LibreChat, Open WebUI, and Python/Node OpenAI SDKs
                using standard OpenAI parameters.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Dual Hosting Modes */}
      <section className="px-6 py-20">
        <div className="mx-auto max-w-5xl space-y-12">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-white">Choose Your Deployment Target</h2>
            <p className="mt-2 text-sm text-slate-400">Deploy anywhere with zero vendor lock-in.</p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-white">Standalone Local Server</h3>
                <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-400 border border-emerald-500/20">
                  Zero Docker / Zero Cloud
                </span>
              </div>
              <p className="mt-3 text-sm text-slate-400">
                Single Node.js process on Port 1001 with embedded SQLite and in-memory vector cosine similarity.
              </p>
              <div className="mt-4 rounded-lg bg-slate-950 p-3 font-mono text-xs text-slate-300">
                npm run local
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-white">Supabase Cloud / Local Docker</h3>
                <span className="rounded-full bg-violet-500/10 px-2.5 py-0.5 text-xs font-semibold text-violet-400 border border-violet-500/20">
                  Production Scalable
                </span>
              </div>
              <p className="mt-3 text-sm text-slate-400">
                PostgreSQL, HNSW pgvector indexing, Supabase Vault, and Edge Functions.
              </p>
              <div className="mt-4 rounded-lg bg-slate-950 p-3 font-mono text-xs text-slate-300">
                npm run setup:local  # or npm run setup
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-950 px-6 py-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 text-xs text-slate-500">
          <div className="space-y-1">
            <p>
              © {new Date().getFullYear()} OniRoute. Designed &amp; Architected by{' '}
              <a
                href="https://github.com/AniruddhaDas1"
                target="_blank"
                rel="noreferrer"
                className="text-slate-300 hover:text-white font-semibold underline underline-offset-2 transition-colors"
              >
                Aniruddha Das
              </a>
              .
            </p>
            <p>
              Powered by{' '}
              <a
                href="https://leadspree.in"
                target="_blank"
                rel="noreferrer"
                className="text-violet-400 hover:text-violet-300 font-medium underline underline-offset-2 transition-colors"
              >
                Leadspree Business Solutions
              </a>
            </p>
          </div>
          <div className="flex items-center gap-6">
            <a
              href="https://github.com/AniruddhaDas1"
              target="_blank"
              rel="noreferrer"
              className="hover:text-slate-300"
            >
              GitHub
            </a>
            <Link to="/dashboard" className="hover:text-slate-300">
              Dashboard
            </Link>
            <Link to="/login" className="hover:text-slate-300">
              Sign In
            </Link>
            <Link to="/signup" className="hover:text-slate-300">
              Create Account
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
