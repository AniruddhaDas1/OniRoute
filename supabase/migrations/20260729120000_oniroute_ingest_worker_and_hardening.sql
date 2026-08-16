-- OniRoute: asynchronous knowledge ingestion, audit-log integrity, and
-- follow-ups from the codebase review.
--
-- Self-contained and idempotent so `supabase db push` reproduces it on a clone.

-- =============================================================================
-- Knowledge ingestion becomes a job with a lease
-- =============================================================================
-- Ingestion used to run inline inside the request that triggered it: up to 80
-- sequential GitHub calls plus 100 sequential embedding calls, with no timeout.
-- That routinely exceeded the Edge Function wall clock and stranded the row in
-- `processing` with no way to recover. It is now a background job with an
-- explicit lease so a dead worker's rows can be reclaimed.

alter table public.knowledge_bases
  add column if not exists ingest_started_at timestamptz,
  add column if not exists ingest_completed_at timestamptz,
  add column if not exists ingest_stats jsonb not null default '{}'::jsonb;

-- Widen the status domain to include the queued state.
alter table public.knowledge_bases drop constraint if exists knowledge_bases_status_check;
alter table public.knowledge_bases
  add constraint knowledge_bases_status_check
  check (status in ('pending', 'queued', 'processing', 'complete', 'error'));

create index if not exists idx_knowledge_bases_status on public.knowledge_bases(status)
  where status in ('queued', 'processing');

-- Atomically take ownership of an ingestion job. Returns NULL when the row is
-- already being processed by a live worker, which is what makes a duplicate
-- trigger harmless. A row stuck in `processing` past the lease is reclaimable.
create or replace function public.claim_knowledge_ingest(
  p_knowledge_base_id uuid,
  p_stale_seconds integer default 900
)
returns public.knowledge_bases
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.knowledge_bases;
begin
  update public.knowledge_bases
     set status = 'processing',
         ingest_started_at = now(),
         ingest_completed_at = null,
         error_message = null,
         ingest_stats = coalesce(ingest_stats, '{}'::jsonb)
           || jsonb_build_object('attempts', coalesce((ingest_stats ->> 'attempts')::integer, 0) + 1)
   where id = p_knowledge_base_id
     and (
       status in ('pending', 'queued', 'error', 'complete')
       or (status = 'processing' and coalesce(ingest_started_at, 'epoch'::timestamptz) < now() - make_interval(secs => p_stale_seconds))
     )
  returning * into claimed;

  return claimed;
end;
$$;

revoke all on function public.claim_knowledge_ingest(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_knowledge_ingest(uuid, integer) to service_role;

-- =============================================================================
-- Token accounting on request logs
-- =============================================================================
-- The provider adapters already parsed usage and then discarded it, leaving a
-- gateway with no idea what it had spent.
alter table public.request_logs
  add column if not exists prompt_tokens integer,
  add column if not exists completion_tokens integer,
  add column if not exists total_tokens integer;

-- =============================================================================
-- Audit-log integrity
-- =============================================================================
-- `request_logs` is the audit trail, and it was writable by the browser role:
-- a user could fabricate or erase their own request history through the Data
-- API. Only the Edge Function (service_role, which bypasses RLS) should write.
-- SELECT stays so the dashboard can still read.
drop policy if exists request_logs_insert_own on public.request_logs;
drop policy if exists request_logs_update_own on public.request_logs;
drop policy if exists request_logs_delete_own on public.request_logs;

-- =============================================================================
-- One secret per provider
-- =============================================================================
-- `upsert_provider_secret` and `get_provider_secret` both assume a single row
-- per provider but nothing enforced it; they papered over duplicates with
-- implicit-first-row and `limit 1`.
delete from public.api_keys_vault a
  using public.api_keys_vault b
 where a.provider_id = b.provider_id
   and a.ctid > b.ctid;

create unique index if not exists idx_api_keys_vault_provider_unique
  on public.api_keys_vault(provider_id);

-- =============================================================================
-- Vector index
-- =============================================================================
-- The ivfflat index was created on an empty table during the initial migration.
-- IVF centroids are computed at build time, so that index was degenerate until
-- someone manually reindexed after loading data. HNSW builds incrementally and
-- needs no training pass, which suits a table that grows one ingestion at a time.
do $$
begin
  create index if not exists idx_vector_chunks_embedding_hnsw
    on public.vector_chunks using hnsw (embedding vector_cosine_ops);
  drop index if exists public.idx_vector_chunks_embedding;
exception
  when undefined_object or feature_not_supported then
    -- pgvector < 0.5 has no HNSW; keep the existing ivfflat index in that case.
    raise notice 'HNSW unavailable; retaining ivfflat index on vector_chunks.embedding';
end $$;

-- =============================================================================
-- Function hardening consistency
-- =============================================================================
-- `handle_new_user` was pinned in the previous migration; this trigger function
-- was missed.
alter function public.update_updated_at() set search_path = public;
revoke all on function public.update_updated_at() from public, anon, authenticated;
