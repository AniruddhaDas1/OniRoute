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

-- 6. Table: gateway_api_keys (4D Gateway Keys & Scopes)
CREATE TABLE IF NOT EXISTS public.gateway_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  max_context_tokens INTEGER,
  provider_group_id UUID REFERENCES public.provider_groups(id) ON DELETE SET NULL,
  routing_mode TEXT CHECK (routing_mode IN ('priority', 'random')),
  gateway_mode TEXT NOT NULL DEFAULT 'direct' CHECK (gateway_mode IN ('direct', 'refined', 'flexible')),
  selected_provider_ids UUID[] DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Table: knowledge_bases (RAG Documents & Repositories)
CREATE TABLE IF NOT EXISTS public.knowledge_bases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('text', 'repo')),
  source_content TEXT,
  source_url TEXT,
  embedding_provider_id UUID REFERENCES public.ai_providers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'complete', 'error')),
  chunk_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  ingest_started_at TIMESTAMPTZ,
  ingest_completed_at TIMESTAMPTZ,
  ingest_stats JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Table: vector_chunks (RAG Chunk Embeddings)
CREATE TABLE IF NOT EXISTS public.vector_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id UUID NOT NULL REFERENCES public.knowledge_bases(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vector_chunks_embedding_idx ON public.vector_chunks 
USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- 9. Table: request_logs (Live Analytics & Failover History)
CREATE TABLE IF NOT EXISTS public.request_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider_id UUID REFERENCES public.ai_providers(id) ON DELETE SET NULL,
  gateway_key_id UUID REFERENCES public.gateway_api_keys(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failover', 'error')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  routing_mode TEXT NOT NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Automatic User Provisioning Trigger
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

-- Backfill existing auth.users into profiles
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

-- 11. Enable Row Level Security (RLS) & Policies
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routing_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gateway_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_bases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vector_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_logs ENABLE ROW LEVEL SECURITY;

-- Profiles Policies (Secure)
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_super_admin_select_all" ON public.profiles;
DROP POLICY IF EXISTS "profiles_super_admin_update_all" ON public.profiles;
DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;
DROP POLICY IF EXISTS "profiles_super_admin_update_only" ON public.profiles;

CREATE POLICY "profiles_select_policy" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    (select auth.uid()) = id 
    OR 
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE id = auth.uid() AND (role = 'super_admin' OR LOWER(email) = 'leadspree24x7@gmail.com')
    )
  );

CREATE POLICY "profiles_super_admin_update_only" ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE id = auth.uid() AND (role = 'super_admin' OR LOWER(email) = 'leadspree24x7@gmail.com')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE id = auth.uid() AND (role = 'super_admin' OR LOWER(email) = 'leadspree24x7@gmail.com')
    )
  );

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

-- 12. Helper & Security DEFINER Functions

-- Super Admin Member Management RPC
CREATE OR REPLACE FUNCTION public.admin_update_member(
  target_user_id UUID,
  new_role TEXT DEFAULT NULL,
  new_is_active BOOLEAN DEFAULT NULL,
  new_access_granted BOOLEAN DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  caller_role TEXT;
  caller_email TEXT;
  target_email TEXT;
  updated_row public.profiles%ROWTYPE;
BEGIN
  IF new_role IS NOT NULL AND new_role NOT IN ('super_admin', 'admin', 'member') THEN
    RAISE EXCEPTION 'Invalid role specified: %. Allowed roles: super_admin, admin, member.', new_role;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    SELECT role, email INTO caller_role, caller_email 
    FROM public.profiles 
    WHERE id = auth.uid();

    IF caller_role != 'super_admin' AND LOWER(COALESCE(caller_email, '')) != 'leadspree24x7@gmail.com' THEN
      RAISE EXCEPTION 'Access denied. Only Super Admin can modify member access.';
    END IF;
  END IF;

  SELECT email INTO target_email FROM public.profiles WHERE id = target_user_id;
  IF LOWER(COALESCE(target_email, '')) = 'leadspree24x7@gmail.com' THEN
    IF (new_role IS NOT NULL AND new_role != 'super_admin') OR new_is_active = false OR new_access_granted = false THEN
      RAISE EXCEPTION 'Cannot demote, deactivate, or revoke access from the root Super Admin (leadspree24x7@gmail.com).';
    END IF;
  END IF;

  UPDATE public.profiles
  SET 
    role = COALESCE(new_role, role),
    is_active = COALESCE(new_is_active, is_active),
    access_granted = COALESCE(new_access_granted, access_granted),
    updated_at = NOW()
  WHERE id = target_user_id
  RETURNING * INTO updated_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Member profile not found for user ID: %', target_user_id;
  END IF;

  RETURN to_jsonb(updated_row);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

REVOKE ALL ON FUNCTION public.admin_update_member(UUID, TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_member(UUID, TEXT, BOOLEAN, BOOLEAN) TO service_role;

-- Vault Secrets Integration RPCs
CREATE OR REPLACE FUNCTION public.get_provider_secret(p_provider_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_secret TEXT;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'provider_' || p_provider_id::text
  LIMIT 1;

  RETURN v_secret;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault;

REVOKE ALL ON FUNCTION public.get_provider_secret(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_provider_secret(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_provider_secret(p_provider_id UUID, p_secret TEXT)
RETURNS VOID AS $$
DECLARE
  v_secret_name TEXT := 'provider_' || p_provider_id::text;
  v_existing_id UUID;
BEGIN
  SELECT id INTO v_existing_id
  FROM vault.secrets
  WHERE name = v_secret_name
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_existing_id, p_secret);
  ELSE
    PERFORM vault.create_secret(p_secret, v_secret_name);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault;

REVOKE ALL ON FUNCTION public.upsert_provider_secret(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_provider_secret(UUID, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.delete_provider_secret(p_provider_id UUID)
RETURNS VOID AS $$
DECLARE
  v_secret_name TEXT := 'provider_' || p_provider_id::text;
  v_existing_id UUID;
BEGIN
  SELECT id INTO v_existing_id
  FROM vault.secrets
  WHERE name = v_secret_name
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_existing_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault;

REVOKE ALL ON FUNCTION public.delete_provider_secret(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_provider_secret(UUID) TO service_role;

-- RAG Ingestion Atomic Lease Claim RPC
CREATE OR REPLACE FUNCTION public.claim_knowledge_ingest(
  p_knowledge_base_id UUID,
  p_stale_seconds INTEGER DEFAULT 900
)
RETURNS JSONB AS $$
DECLARE
  v_row public.knowledge_bases%ROWTYPE;
BEGIN
  UPDATE public.knowledge_bases
  SET
    status = 'processing',
    ingest_started_at = NOW(),
    error_message = NULL
  WHERE id = p_knowledge_base_id
    AND (
      status IN ('queued', 'error')
      OR (
        status = 'processing'
        AND ingest_started_at < NOW() - (p_stale_seconds || ' seconds')::INTERVAL
      )
    )
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN to_jsonb(v_row);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.claim_knowledge_ingest(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_knowledge_ingest(UUID, INTEGER) TO service_role;
