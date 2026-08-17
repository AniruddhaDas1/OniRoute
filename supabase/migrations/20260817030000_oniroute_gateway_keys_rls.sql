-- =============================================================================
-- Grant Row Level Security Policies for gateway_api_keys and provider_groups
-- =============================================================================

ALTER TABLE public.gateway_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_groups ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "gateway_api_keys_select_own" ON public.gateway_api_keys;
DROP POLICY IF EXISTS "gateway_api_keys_insert_own" ON public.gateway_api_keys;
DROP POLICY IF EXISTS "gateway_api_keys_update_own" ON public.gateway_api_keys;
DROP POLICY IF EXISTS "gateway_api_keys_delete_own" ON public.gateway_api_keys;
DROP POLICY IF EXISTS "gateway_api_keys_all_own" ON public.gateway_api_keys;

-- Create policies for gateway_api_keys
CREATE POLICY "gateway_api_keys_select_own" ON public.gateway_api_keys
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "gateway_api_keys_insert_own" ON public.gateway_api_keys
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "gateway_api_keys_update_own" ON public.gateway_api_keys
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "gateway_api_keys_delete_own" ON public.gateway_api_keys
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Also ensure provider_groups has complete RLS policies
DROP POLICY IF EXISTS "provider_groups_select_own" ON public.provider_groups;
DROP POLICY IF EXISTS "provider_groups_insert_own" ON public.provider_groups;
DROP POLICY IF EXISTS "provider_groups_update_own" ON public.provider_groups;
DROP POLICY IF EXISTS "provider_groups_delete_own" ON public.provider_groups;
DROP POLICY IF EXISTS "provider_groups_all_own" ON public.provider_groups;

CREATE POLICY "provider_groups_select_own" ON public.provider_groups
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "provider_groups_insert_own" ON public.provider_groups
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "provider_groups_update_own" ON public.provider_groups
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "provider_groups_delete_own" ON public.provider_groups
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));
