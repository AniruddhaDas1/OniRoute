-- =============================================================================
-- OniRoute AI Provider Groups & Key-Level Routing Assignment Migration
-- =============================================================================
-- Allows creating named Provider Groups (e.g. "Coding LLMs", "Ollama Cluster")
-- with dedicated routing strategies and assigning Gateway Keys to specific groups,
-- routing modes, and pipeline modes (Direct vs Refined).
-- =============================================================================

-- 1. Table: provider_groups
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

CREATE INDEX IF NOT EXISTS idx_provider_groups_user ON public.provider_groups(user_id, created_at DESC);

-- 2. Add columns to gateway_api_keys
ALTER TABLE public.gateway_api_keys
  ADD COLUMN IF NOT EXISTS provider_group_id UUID REFERENCES public.provider_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS routing_mode TEXT DEFAULT NULL CHECK (routing_mode IN ('priority', 'random')),
  ADD COLUMN IF NOT EXISTS gateway_mode TEXT DEFAULT 'flexible' CHECK (gateway_mode IN ('direct', 'refined', 'flexible')),
  ADD COLUMN IF NOT EXISTS selected_provider_ids UUID[] DEFAULT NULL;

-- 3. Row Level Security for provider_groups
ALTER TABLE public.provider_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "provider_groups_all_own" ON public.provider_groups;
CREATE POLICY "provider_groups_all_own" ON public.provider_groups FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
