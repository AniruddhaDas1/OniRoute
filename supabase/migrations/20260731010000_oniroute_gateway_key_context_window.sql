-- =============================================================================
-- OniRoute Gateway Key Context Window Isolation Migration
-- =============================================================================
-- Allows each generated gateway key to have an isolated optional context window
-- ceiling (e.g. 200k, 256k, 500k, 1M, or NULL for model default).
-- =============================================================================

ALTER TABLE public.gateway_keys
  ADD COLUMN IF NOT EXISTS max_context_tokens INTEGER DEFAULT NULL;
