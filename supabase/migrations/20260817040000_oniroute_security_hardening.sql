-- =============================================================================
-- OniRoute Security Hardening Migration
-- =============================================================================
-- 1. Tightens public.profiles RLS so ordinary members CANNOT elevate their role,
--    activate/deactivate themselves, or modify access control flags.
-- 2. Restricts SECURITY DEFINER RPCs (admin_update_member, get_provider_secret)
--    to service_role only and validates caller authority.
-- =============================================================================

-- 1. Fix Profiles RLS Policies
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_super_admin_select_all" ON public.profiles;
DROP POLICY IF EXISTS "profiles_super_admin_update_all" ON public.profiles;
DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;
DROP POLICY IF EXISTS "profiles_super_admin_update_only" ON public.profiles;

-- Regular users can view their own profile; Super Admin can view all profiles
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

-- ONLY Super Admins can update profiles (including role, is_active, access_granted)
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

-- 2. Harden admin_update_member() SECURITY DEFINER Function
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
  -- Validate role input if provided
  IF new_role IS NOT NULL AND new_role NOT IN ('super_admin', 'admin', 'member') THEN
    RAISE EXCEPTION 'Invalid role specified: %. Allowed roles: super_admin, admin, member.', new_role;
  END IF;

  -- Verify caller is super_admin if called in an authenticated session context
  IF auth.uid() IS NOT NULL THEN
    SELECT role, email INTO caller_role, caller_email 
    FROM public.profiles 
    WHERE id = auth.uid();

    IF caller_role != 'super_admin' AND LOWER(COALESCE(caller_email, '')) != 'leadspree24x7@gmail.com' THEN
      RAISE EXCEPTION 'Access denied. Only Super Admin can modify member access.';
    END IF;
  END IF;

  -- Protect root super admin from demotion or deactivation
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

-- Strictly restrict execution to service_role (Edge Functions control plane)
REVOKE ALL ON FUNCTION public.admin_update_member(UUID, TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_update_member(UUID, TEXT, BOOLEAN, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.admin_update_member(UUID, TEXT, BOOLEAN, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_member(UUID, TEXT, BOOLEAN, BOOLEAN) TO service_role;

-- Ensure Vault secrets functions remain strictly service_role only
REVOKE ALL ON FUNCTION public.get_provider_secret(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_provider_secret(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.upsert_provider_secret(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_provider_secret(UUID, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.delete_provider_secret(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_provider_secret(UUID) TO service_role;
