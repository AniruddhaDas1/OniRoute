#!/usr/bin/env bash
set -euo pipefail

MODE="cloud"
if [[ "${1:-}" == "--local" ]]; then
  MODE="local"
fi

echo "========================================"
echo "  OniRoute — Setup (${MODE^^} MODE)"
echo "========================================"
echo ""

# Helper to invoke supabase CLI (prefers local/npx if global not installed)
supabase_cmd() {
  if command -v supabase >/dev/null 2>&1; then
    supabase "$@"
  else
    npx -y supabase@2.109.1 "$@"
  fi
}

# --- Prerequisites check ---
command -v node >/dev/null 2>&1 || { echo "❌ Node.js is required but not installed. Download from https://nodejs.org"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "❌ npm is required but not installed."; exit 1; }

if [ "$MODE" = "local" ]; then
  command -v docker >/dev/null 2>&1 || { echo "❌ Docker is required for local Supabase. Please install Docker Desktop."; exit 1; }
  docker info >/dev/null 2>&1 || { echo "❌ Docker daemon is not running. Please start Docker and re-run."; exit 1; }
  echo "✅ Node, npm & Docker OK"
else
  echo "✅ Node & npm OK"
fi
echo ""

# --- Execution ---
if [ "$MODE" = "local" ]; then
  echo "🚀 Starting local Supabase stack (PostgreSQL + pgvector + Vault + Auth + Edge Functions)..."
  supabase_cmd start

  echo "📋 Configuring local .env..."
  # Local default anon key from Supabase CLI
  LOCAL_URL="http://127.0.0.1:54321"
  LOCAL_ANON_KEY="$(supabase_cmd status -o env | grep 'ANON_KEY' | cut -d '=' -f2- | tr -d '\"' || echo 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM0NTk5NDl9.dummy')"

  cat > .env <<EOF
VITE_SUPABASE_URL=${LOCAL_URL}
VITE_SUPABASE_ANON_KEY=${LOCAL_ANON_KEY}

# Optional: Seed account credentials for npm run seed
# ONIROUTE_EMAIL=admin@oniroute.local
# ONIROUTE_PASSWORD=password123
# GITHUB_TOKEN=
EOF

  echo "✅ Local .env generated"
  echo ""
  echo "📦 Applying local database migrations..."
  supabase_cmd db reset || { echo "❌ Local database migration reset failed. Check error above."; exit 1; }
  echo "✅ Local migrations applied"
  echo ""

else
  # Cloud mode
  if [ ! -f .env ]; then
    echo "📋 Creating .env from .env.example..."
    cp .env.example .env
    echo "   Edit .env and add your Supabase project URL and publishable/anon key, then re-run this script."
    exit 0
  fi

  source .env

  if [ -z "${VITE_SUPABASE_URL:-}" ] || [ "${VITE_SUPABASE_URL:-}" = "https://skbbzlwzsarmideehvmz.supabase.co" ]; then
    echo "⚠️  VITE_SUPABASE_URL is not configured in .env"
    echo "   Edit .env and add your Supabase project URL, then re-run this script."
    exit 1
  fi

  if [ -z "${VITE_SUPABASE_ANON_KEY:-}" ] || [ "${VITE_SUPABASE_ANON_KEY:-}" = "your-publishable-or-anon-key" ]; then
    echo "⚠️  VITE_SUPABASE_ANON_KEY is not configured in .env"
    echo "   Edit .env and add your Supabase anon key, then re-run this script."
    exit 1
  fi

  echo "✅ .env configured"
  echo ""

  # Link to project
  PROJECT_REF="$(echo "$VITE_SUPABASE_URL" | sed -E 's|https://([^.]+).*|\1|')"
  echo "🔗 Linking to Supabase project (${PROJECT_REF})..."
  supabase_cmd link --project-ref "$PROJECT_REF" || true
  echo "✅ Supabase project linked"
  echo ""

  echo "📦 Pushing database migrations..."
  supabase_cmd db push || { echo "❌ Migration push failed. Check your Supabase CLI connection."; exit 1; }
  echo "✅ Migrations applied"
  echo ""

  echo "🚀 Deploying Edge Functions..."
  supabase_cmd functions deploy api --use-api || { echo "⚠️  Function deploy failed. You may need to run this manually."; }
  supabase_cmd functions deploy embed-knowledge --use-api || { echo "⚠️  embed-knowledge deploy failed. You may need to run this manually."; }
  echo "✅ Edge Functions deployed"
  echo ""
fi

# Optional seed
if [ -n "${ONIROUTE_EMAIL:-}" ] && [ -n "${ONIROUTE_PASSWORD:-}" ]; then
  echo "🌱 Seeding curated knowledge bases..."
  node scripts/seed-knowledge.mjs --ingest || echo "⚠️  Seeding skipped or failed."
fi

echo ""
echo "========================================"
echo "  ✅ Setup complete!"
echo "========================================"
echo ""
echo "  Dashboard:    http://localhost:5173"
if [ "$MODE" = "local" ]; then
  echo "  Supabase Studio (Local): http://127.0.0.1:54323"
  echo "  API endpoint: http://127.0.0.1:54321/functions/v1/api/v1/chat/completions"
else
  echo "  API endpoint: ${VITE_SUPABASE_URL}/functions/v1/api/v1/chat/completions"
fi
echo ""
echo "  Start the dashboard with:"
echo "    npm run dev"
echo ""