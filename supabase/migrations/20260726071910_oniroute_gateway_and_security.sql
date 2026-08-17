-- OniRoute gateway, secure secret handling, and RAG support.
-- This migration is intentionally self-contained so a cloned repository can
-- reproduce the schema with `supabase db push`.

create extension if not exists supabase_vault with schema vault;

alter function public.handle_new_user() set search_path = public, auth;
revoke all on function public.handle_new_user() from public, anon, authenticated;

alter table public.api_keys_vault
  add column if not exists secret_id uuid;

alter table public.ai_providers
  add column if not exists embedding_model_name text;

alter table public.knowledge_bases
  add column if not exists source_content text,
  add column if not exists error_message text,
  add column if not exists embedding_provider_id uuid references public.ai_providers(id) on delete set null;

create table if not exists public.gateway_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null default 'Default key',
  key_prefix text not null,
  key_hash text not null unique,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_gateway_api_keys_user on public.gateway_api_keys(user_id, created_at desc);

alter table public.gateway_api_keys enable row level security;

drop policy if exists "gateway_api_keys_select_own" on public.gateway_api_keys;
drop policy if exists "gateway_api_keys_insert_own" on public.gateway_api_keys;
drop policy if exists "gateway_api_keys_update_own" on public.gateway_api_keys;
drop policy if exists "gateway_api_keys_delete_own" on public.gateway_api_keys;

-- Browser clients never see a hashed gateway credential. All gateway-key
-- management is performed by the authenticated Edge Function.

-- Existing table policy definitions predate `TO authenticated` and lack
-- UPDATE checks. Recreate them with an ownership predicate on every action.
do $$
declare
  target text;
  tables text[] := array['profiles', 'ai_providers', 'api_keys_vault', 'routing_configs', 'knowledge_bases', 'vector_chunks', 'request_logs'];
begin
  foreach target in array tables loop
    execute format('drop policy if exists %I on public.%I', target || '_select_own', target);
    execute format('drop policy if exists %I on public.%I', target || '_insert_own', target);
    execute format('drop policy if exists %I on public.%I', target || '_update_own', target);
    execute format('drop policy if exists %I on public.%I', target || '_delete_own', target);
  end loop;
end $$;

create policy profiles_select_own on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy profiles_insert_own on public.profiles for insert to authenticated with check ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy ai_providers_select_own on public.ai_providers for select to authenticated using ((select auth.uid()) = user_id);
create policy ai_providers_insert_own on public.ai_providers for insert to authenticated with check ((select auth.uid()) = user_id);
create policy ai_providers_update_own on public.ai_providers for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy ai_providers_delete_own on public.ai_providers for delete to authenticated using ((select auth.uid()) = user_id);

-- No SELECT policy for secrets: an API key must never travel through the Data API.
create policy api_keys_vault_insert_own on public.api_keys_vault for insert to authenticated with check ((select auth.uid()) = user_id);
create policy api_keys_vault_update_own on public.api_keys_vault for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy api_keys_vault_delete_own on public.api_keys_vault for delete to authenticated using ((select auth.uid()) = user_id);

create policy routing_configs_select_own on public.routing_configs for select to authenticated using ((select auth.uid()) = user_id);
create policy routing_configs_insert_own on public.routing_configs for insert to authenticated with check ((select auth.uid()) = user_id);
create policy routing_configs_update_own on public.routing_configs for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy routing_configs_delete_own on public.routing_configs for delete to authenticated using ((select auth.uid()) = user_id);

create policy knowledge_bases_select_own on public.knowledge_bases for select to authenticated using ((select auth.uid()) = user_id);
create policy knowledge_bases_insert_own on public.knowledge_bases for insert to authenticated with check ((select auth.uid()) = user_id);
create policy knowledge_bases_update_own on public.knowledge_bases for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy knowledge_bases_delete_own on public.knowledge_bases for delete to authenticated using ((select auth.uid()) = user_id);

create policy vector_chunks_select_own on public.vector_chunks for select to authenticated using ((select auth.uid()) = user_id);
create policy vector_chunks_insert_own on public.vector_chunks for insert to authenticated with check ((select auth.uid()) = user_id);
create policy vector_chunks_update_own on public.vector_chunks for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy vector_chunks_delete_own on public.vector_chunks for delete to authenticated using ((select auth.uid()) = user_id);

create policy request_logs_select_own on public.request_logs for select to authenticated using ((select auth.uid()) = user_id);
create policy request_logs_insert_own on public.request_logs for insert to authenticated with check ((select auth.uid()) = user_id);
create policy request_logs_update_own on public.request_logs for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy request_logs_delete_own on public.request_logs for delete to authenticated using ((select auth.uid()) = user_id);

-- The helper functions are only invokable by the service-role client inside
-- the Edge Function. They bridge that trusted runtime to Vault while keeping
-- decryption unavailable to browser sessions.
create or replace function public.upsert_provider_secret(p_provider_id uuid, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  existing_secret uuid;
  new_secret uuid;
begin
  select secret_id into existing_secret from public.api_keys_vault where provider_id = p_provider_id;
  if existing_secret is not null then
    perform vault.update_secret(existing_secret, p_secret);
    return existing_secret;
  end if;
  new_secret := vault.create_secret(p_secret, 'oniroute_provider_' || p_provider_id::text);
  insert into public.api_keys_vault (user_id, provider_id, vault_key, secret_id)
  select user_id, id, 'vault:' || new_secret::text, new_secret from public.ai_providers where id = p_provider_id;
  return new_secret;
end;
$$;

create or replace function public.get_provider_secret(p_provider_id uuid)
returns text
language sql
security definer
set search_path = public, vault
stable
as $$
  select ds.decrypted_secret
  from public.api_keys_vault ak
  join vault.decrypted_secrets ds on ds.id = ak.secret_id
  where ak.provider_id = p_provider_id
  limit 1;
$$;

create or replace function public.delete_provider_secret(p_provider_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare secret_to_delete uuid;
begin
  select secret_id into secret_to_delete from public.api_keys_vault where provider_id = p_provider_id;
  if secret_to_delete is not null then
    perform vault.delete_secret(secret_to_delete);
  end if;
end;
$$;

revoke all on function public.upsert_provider_secret(uuid, text) from public, anon, authenticated;
revoke all on function public.get_provider_secret(uuid) from public, anon, authenticated;
revoke all on function public.delete_provider_secret(uuid) from public, anon, authenticated;
grant execute on function public.upsert_provider_secret(uuid, text) to service_role;
grant execute on function public.get_provider_secret(uuid) to service_role;
grant execute on function public.delete_provider_secret(uuid) to service_role;

-- The Edge Function invokes this through its service-role client after it has
-- authenticated the caller; it is intentionally not granted to browser roles.
create or replace function public.match_oniroute_chunks(
  p_user_id uuid,
  p_embedding vector(1536),
  p_match_count integer default 6,
  p_knowledge_base_id uuid default null
)
returns table (id uuid, content text, metadata jsonb, similarity real)
language sql
security definer
set search_path = public, extensions
stable
as $$
  select vc.id, vc.content, vc.metadata,
         (1 - (vc.embedding <=> p_embedding))::real as similarity
  from public.vector_chunks vc
  where vc.user_id = p_user_id
    and vc.embedding is not null
    and (p_knowledge_base_id is null or vc.knowledge_base_id = p_knowledge_base_id)
  order by vc.embedding <=> p_embedding
  limit greatest(1, least(p_match_count, 12));
$$;

revoke all on function public.match_oniroute_chunks(uuid, vector, integer, uuid) from public, anon, authenticated;
grant execute on function public.match_oniroute_chunks(uuid, vector, integer, uuid) to service_role;
