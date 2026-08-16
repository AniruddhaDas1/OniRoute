-- =============================================================================
-- OniRoute Core Database Migration
-- =============================================================================
-- This migration creates the foundational schema for OniRoute:
-- - Extensions (uuid-ossp, pgvector, vault)
-- - Core tables (profiles, ai_providers, api_keys_vault, routing_configs,
--   knowledge_bases, vector_chunks, request_logs)
-- - Indexes for performance
-- - Row Level Security (RLS) policies
-- - Triggers for auto-profile creation and updated_at timestamps
--
-- API keys are managed via the Supabase Vault (supabase-vault npm package).
-- The api_keys_vault table stores only the vault_key reference (format:
-- "vault:v1:<uuid>"). The actual secret is stored in Vault by the edge
-- function, and the reference is rotated via rotate_secret() when keys
-- are updated.
-- =============================================================================

-- =============================================================================
-- Extensions
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================================
-- Table: profiles
-- =============================================================================
-- Auto-created when a new user signs up (via trigger below).
-- Stores the minimal user profile linked to Supabase Auth.
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- Table: ai_providers
-- =============================================================================
-- Stores each user's configured AI providers (OpenAI, Anthropic, etc.).
-- Priority ordering determines failover sequence.
CREATE TABLE public.ai_providers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('openai', 'anthropic', 'google', 'custom')),
  endpoint TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model_name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- Table: api_keys_vault
-- =============================================================================
-- Stores Vault references for encrypted API keys. The actual secret lives
-- in Supabase Vault; this table only holds the vault_key reference string
-- (format: "vault:v1:<uuid>").
--
-- Edge function workflow:
--   CREATE: create_secret() -> store returned vault_key here
--   READ:   read_secret(vault_key) -> decrypt and use
--   UPDATE: rotate_secret(vault_key, new_value) -> vault_key stays the same
--   DELETE: delete_secret(vault_key) -> remove from Vault, then delete this row
CREATE TABLE public.api_keys_vault (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES public.ai_providers(id) ON DELETE CASCADE,
  vault_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- Table: routing_configs
-- =============================================================================
-- One routing config per user (enforced by UNIQUE on user_id).
-- Controls how requests are dispatched across providers.
CREATE TABLE public.routing_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE UNIQUE,
  mode TEXT NOT NULL DEFAULT 'priority' CHECK (mode IN ('priority', 'random')),
  failover_enabled BOOLEAN NOT NULL DEFAULT true,
  max_retries INTEGER NOT NULL DEFAULT 3,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- Table: knowledge_bases
-- =============================================================================
-- Represents a user's knowledge base (uploaded file, repo, or raw text).
-- Status tracks the ingestion pipeline: pending -> processing -> complete/error.
CREATE TABLE public.knowledge_bases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('file', 'repo', 'text')),
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'complete', 'error')),
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- Table: vector_chunks
-- =============================================================================
-- Stores chunked content and embeddings for RAG.
-- Embedding dimension: 1536 (OpenAI text-embedding-3-small default).
CREATE TABLE public.vector_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  knowledge_base_id UUID NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- Table: request_logs
-- =============================================================================
-- Audit log for all routed requests. Tracks success/error/failover events
-- with latency and optional error details.
CREATE TABLE public.request_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider_id UUID REFERENCES public.ai_providers(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'failover')),
  latency_ms INTEGER,
  error_message TEXT,
  mode TEXT NOT NULL DEFAULT 'direct' CHECK (mode IN ('direct', 'refined')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- Indexes
-- =============================================================================
CREATE INDEX idx_ai_providers_user_id ON public.ai_providers(user_id);
CREATE INDEX idx_ai_providers_priority ON public.ai_providers(user_id, priority);
CREATE INDEX idx_api_keys_vault_provider ON public.api_keys_vault(provider_id);
CREATE INDEX idx_knowledge_bases_user_id ON public.knowledge_bases(user_id);
CREATE INDEX idx_vector_chunks_user_id ON public.vector_chunks(user_id);
CREATE INDEX idx_vector_chunks_kb_id ON public.vector_chunks(knowledge_base_id);
CREATE INDEX idx_vector_chunks_embedding ON public.vector_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_request_logs_user_id ON public.request_logs(user_id, created_at DESC);

-- =============================================================================
-- Row Level Security (RLS)
-- =============================================================================

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routing_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vector_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_logs ENABLE ROW LEVEL SECURITY;

-- Profiles policies (id = auth.uid())
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- AI Providers policies (user_id = auth.uid())
CREATE POLICY "ai_providers_select_own" ON public.ai_providers
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "ai_providers_insert_own" ON public.ai_providers
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "ai_providers_update_own" ON public.ai_providers
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "ai_providers_delete_own" ON public.ai_providers
  FOR DELETE USING (auth.uid() = user_id);

-- API Keys Vault policies (user_id = auth.uid())
CREATE POLICY "api_keys_vault_select_own" ON public.api_keys_vault
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "api_keys_vault_insert_own" ON public.api_keys_vault
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "api_keys_vault_update_own" ON public.api_keys_vault
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "api_keys_vault_delete_own" ON public.api_keys_vault
  FOR DELETE USING (auth.uid() = user_id);

-- Routing Configs policies (user_id = auth.uid())
CREATE POLICY "routing_configs_select_own" ON public.routing_configs
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "routing_configs_insert_own" ON public.routing_configs
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "routing_configs_update_own" ON public.routing_configs
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "routing_configs_delete_own" ON public.routing_configs
  FOR DELETE USING (auth.uid() = user_id);

-- Knowledge Bases policies (user_id = auth.uid())
CREATE POLICY "knowledge_bases_select_own" ON public.knowledge_bases
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "knowledge_bases_insert_own" ON public.knowledge_bases
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "knowledge_bases_update_own" ON public.knowledge_bases
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "knowledge_bases_delete_own" ON public.knowledge_bases
  FOR DELETE USING (auth.uid() = user_id);

-- Vector Chunks policies (user_id = auth.uid())
CREATE POLICY "vector_chunks_select_own" ON public.vector_chunks
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "vector_chunks_insert_own" ON public.vector_chunks
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "vector_chunks_update_own" ON public.vector_chunks
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "vector_chunks_delete_own" ON public.vector_chunks
  FOR DELETE USING (auth.uid() = user_id);

-- Request Logs policies (user_id = auth.uid())
CREATE POLICY "request_logs_select_own" ON public.request_logs
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "request_logs_insert_own" ON public.request_logs
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "request_logs_update_own" ON public.request_logs
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "request_logs_delete_own" ON public.request_logs
  FOR DELETE USING (auth.uid() = user_id);

-- =============================================================================
-- Trigger: Auto-create profile on user signup
-- =============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================================================
-- Trigger: Auto-update updated_at on ai_providers
-- =============================================================================
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ai_providers_updated_at
  BEFORE UPDATE ON public.ai_providers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
