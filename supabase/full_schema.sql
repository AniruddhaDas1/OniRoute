-- =============================================================================
-- OniRoute Complete Database Setup (All-in-One for Supabase SQL Editor)
-- =============================================================================
-- Run this in your Supabase Project SQL Editor:
-- https://supabase.com/dashboard/project/skbbzlwzsarmideehvmz/sql/new
-- =============================================================================

-- 1. Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Table: profiles (User Accounts, Roles, Access Control)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('super_admin', 'admin', 'member')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  access_granted BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Table: ai_providers (Configured Upstream AI LLMs)
CREATE TABLE IF NOT EXISTS public.ai_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('openai', 'anthropic', 'google', 'ollama', 'custom')),
  endpoint TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model_name TEXT NOT NULL,
  embedding_model_name TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Table: routing_configs (Routing Algorithm & Timeout Settings)
CREATE TABLE IF NOT EXISTS public.routing_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE UNIQUE,
  mode TEXT NOT NULL DEFAULT 'priority' CHECK (mode IN ('priority', 'random')),
  failover_enabled BOOLEAN NOT NULL DEFAULT true,
  max_retries INTEGER NOT NULL DEFAULT 3,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  refine_prompt TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Table: provider_groups (AI Provider Groups / Routing Profiles)
CREATE TABLE IF NOT EXISTS public.provider_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  routing_mode TEXT NOT NULL DEFAULT 'priority' CHECK (routing_mode IN ('priority', 'random')),
  provider_ids UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Table: gateway_api_keys (OniRoute Gateway Inference Keys)
CREATE TABLE IF NOT EXISTS public.gateway_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Default key',
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  provider_group_id UUID REFERENCES public.provider_groups(id) ON DELETE SET NULL,
  routing_mode TEXT DEFAULT NULL CHECK (routing_mode IN ('priority', 'random')),
  gateway_mode TEXT DEFAULT 'flexible' CHECK (gateway_mode IN ('direct', 'refined', 'flexible')),
  selected_provider_ids UUID[] DEFAULT NULL,
  max_context_tokens INTEGER DEFAULT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Table: knowledge_bases (Vector RAG Knowledge Collections)
CREATE TABLE IF NOT EXISTS public.knowledge_bases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('file', 'repo', 'text')),
  source_url TEXT,
  source_content TEXT,
  error_message TEXT,
  embedding_provider_id UUID REFERENCES public.ai_providers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'processing', 'complete', 'error')),
  chunk_count INTEGER NOT NULL DEFAULT 0,
  ingest_started_at TIMESTAMPTZ,
  ingest_completed_at TIMESTAMPTZ,
  ingest_stats JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Table: vector_chunks (Embedding Vector Chunks for RAG)
CREATE TABLE IF NOT EXISTS public.vector_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  knowledge_base_id UUID NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Table: request_logs (Audit Trail, Token Counts, Latencies)
CREATE TABLE IF NOT EXISTS public.request_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider_id UUID REFERENCES public.ai_providers(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'error', 'failover')),
  latency_ms INTEGER,
  error_message TEXT,
  mode TEXT NOT NULL DEFAULT 'direct' CHECK (mode IN ('direct', 'refined')),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for blazing fast performance
CREATE INDEX IF NOT EXISTS idx_ai_providers_user_priority ON public.ai_providers(user_id, priority);
CREATE INDEX IF NOT EXISTS idx_gateway_api_keys_user ON public.gateway_api_keys(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_user ON public.knowledge_bases(user_id);
CREATE INDEX IF NOT EXISTS idx_vector_chunks_kb ON public.vector_chunks(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_user_created ON public.request_logs(user_id, created_at DESC);

-- 9. Auto-create User Profile on Auth Signup Trigger
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, role, is_active, access_granted)
  VALUES (
    NEW.id,
    NEW.email,
    CASE 
      WHEN LOWER(NEW.email) = 'leadspree24x7@gmail.com' THEN 'super_admin'
      ELSE 'member'
    END,
    true,
    true
  )
  ON CONFLICT (id) DO UPDATE
  SET 
    email = EXCLUDED.email,
    role = CASE 
      WHEN LOWER(EXCLUDED.email) = 'leadspree24x7@gmail.com' THEN 'super_admin'
      ELSE profiles.role
    END;

  -- Create default routing config for user
  INSERT INTO public.routing_configs (user_id, mode, failover_enabled, max_retries, timeout_ms)
  VALUES (NEW.id, 'priority', true, 3, 10000)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Backfill existing auth users if any already signed up
INSERT INTO public.profiles (id, email, role, is_active, access_granted)
SELECT 
  id, 
  email,
  CASE WHEN LOWER(email) = 'leadspree24x7@gmail.com' THEN 'super_admin' ELSE 'member' END,
  true,
  true
FROM auth.users
ON CONFLICT (id) DO UPDATE
SET role = CASE WHEN LOWER(EXCLUDED.email) = 'leadspree24x7@gmail.com' THEN 'super_admin' ELSE profiles.role END;

-- Backfill default routing configs for existing users
INSERT INTO public.routing_configs (user_id, mode, failover_enabled, max_retries, timeout_ms)
SELECT id, 'priority', true, 3, 10000
FROM public.profiles
ON CONFLICT (user_id) DO NOTHING;

-- 10. Enable Row Level Security (RLS) & Policies
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routing_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gateway_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vector_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_logs ENABLE ROW LEVEL SECURITY;

-- Profiles Policies
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT TO authenticated
  USING ((select auth.uid()) = id OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND (role = 'super_admin' OR LOWER(email) = 'leadspree24x7@gmail.com')));

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE TO authenticated
  USING ((select auth.uid()) = id OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND (role = 'super_admin' OR LOWER(email) = 'leadspree24x7@gmail.com')));

-- AI Providers Policies
DROP POLICY IF EXISTS "ai_providers_all_own" ON public.ai_providers;
CREATE POLICY "ai_providers_all_own" ON public.ai_providers FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

-- Provider Groups Policies
DROP POLICY IF EXISTS "provider_groups_all_own" ON public.provider_groups;
CREATE POLICY "provider_groups_all_own" ON public.provider_groups FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

-- Routing Configs Policies
DROP POLICY IF EXISTS "routing_configs_all_own" ON public.routing_configs;
CREATE POLICY "routing_configs_all_own" ON public.routing_configs FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

-- Gateway API Keys Policies
DROP POLICY IF EXISTS "gateway_api_keys_all_own" ON public.gateway_api_keys;
CREATE POLICY "gateway_api_keys_all_own" ON public.gateway_api_keys FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

-- Knowledge Bases Policies
DROP POLICY IF EXISTS "knowledge_bases_all_own" ON public.knowledge_bases;
CREATE POLICY "knowledge_bases_all_own" ON public.knowledge_bases FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

-- Vector Chunks Policies
DROP POLICY IF EXISTS "vector_chunks_all_own" ON public.vector_chunks;
CREATE POLICY "vector_chunks_all_own" ON public.vector_chunks FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

-- Request Logs Policies
DROP POLICY IF EXISTS "request_logs_all_own" ON public.request_logs;
CREATE POLICY "request_logs_all_own" ON public.request_logs FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
