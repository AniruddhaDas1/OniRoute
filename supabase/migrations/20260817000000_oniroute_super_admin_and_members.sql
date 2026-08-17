-- =============================================================================
-- OniRoute Super Admin & Member Access Control Migration
-- =============================================================================
-- Configures leadspree24x7@gmail.com as the root Super Admin and establishes
-- role-based member management and access control (Grant/Revoke access).
-- =============================================================================

-- 1. Add role and access control columns to profiles table
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('super_admin', 'admin', 'member')),
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS access_granted BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- 2. Update the handle_new_user trigger to automatically assign leadspree24x7@gmail.com as super_admin
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

-- 3. Promote leadspree24x7@gmail.com if record already exists
UPDATE public.profiles
SET 
  role = 'super_admin',
  is_active = true,
  access_granted = true,
  updated_at = NOW()
WHERE LOWER(email) = 'leadspree24x7@gmail.com';

-- 4. Row Level Security Policies for Member Management
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_super_admin_select_all" ON public.profiles;
DROP POLICY IF EXISTS "profiles_super_admin_update_all" ON public.profiles;

-- Regular members can view their own profile
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    (select auth.uid()) = id 
    OR 
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE id = auth.uid() AND (role = 'super_admin' OR LOWER(email) = 'leadspree24x7@gmail.com')
    )
  );

-- Super admin can update member status & roles
CREATE POLICY "profiles_super_admin_update_all" ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    (select auth.uid()) = id 
    OR 
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE id = auth.uid() AND (role = 'super_admin' OR LOWER(email) = 'leadspree24x7@gmail.com')
    )
  );

-- 5. Helper function for admin member status updates
CREATE OR REPLACE FUNCTION public.admin_update_member(
  target_user_id UUID,
  new_role TEXT,
  new_is_active BOOLEAN,
  new_access_granted BOOLEAN
)
RETURNS JSONB AS $$
DECLARE
  caller_role TEXT;
  caller_email TEXT;
  updated_row public.profiles%ROWTYPE;
BEGIN
  -- Verify caller is super_admin
  SELECT role, email INTO caller_role, caller_email 
  FROM public.profiles 
  WHERE id = auth.uid();

  IF caller_role != 'super_admin' AND LOWER(caller_email) != 'leadspree24x7@gmail.com' THEN
    RAISE EXCEPTION 'Access denied. Only Super Admin can modify member access.';
  END IF;

  -- Prevent demoting or deactivating the root super admin
  IF target_user_id = auth.uid() AND (new_role != 'super_admin' OR new_is_active = false OR new_access_granted = false) THEN
    RAISE EXCEPTION 'Cannot demote or deactivate the root Super Admin account.';
  END IF;

  UPDATE public.profiles
  SET 
    role = COALESCE(new_role, role),
    is_active = COALESCE(new_is_active, is_active),
    access_granted = COALESCE(new_access_granted, access_granted),
    updated_at = NOW()
  WHERE id = target_user_id
  RETURNING * INTO updated_row;

  RETURN to_jsonb(updated_row);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;
