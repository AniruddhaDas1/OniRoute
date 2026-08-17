-- =============================================================================
-- Ensure all auth.users have matching rows in public.profiles
-- =============================================================================

INSERT INTO public.profiles (id, email, role, is_active, access_granted)
SELECT 
  id, 
  email,
  CASE WHEN LOWER(email) = 'leadspree24x7@gmail.com' THEN 'super_admin' ELSE 'member' END,
  true,
  true
FROM auth.users
ON CONFLICT (id) DO UPDATE
SET 
  email = EXCLUDED.email,
  role = CASE WHEN LOWER(EXCLUDED.email) = 'leadspree24x7@gmail.com' THEN 'super_admin' ELSE profiles.role END;

-- Also ensure default routing configs exist for all profiles
INSERT INTO public.routing_configs (user_id, mode, failover_enabled, max_retries, timeout_ms)
SELECT id, 'priority', true, 3, 10000
FROM public.profiles
ON CONFLICT (user_id) DO NOTHING;
