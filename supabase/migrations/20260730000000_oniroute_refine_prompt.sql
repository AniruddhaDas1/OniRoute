-- =============================================================================
-- OniRoute Refine Prompt Migration
-- =============================================================================
-- Adds a `refine_prompt` column to `routing_configs` so users can define
-- a default system instruction that transforms user messages before they
-- reach the upstream AI provider.
-- =============================================================================

ALTER TABLE public.routing_configs
  ADD COLUMN refine_prompt TEXT DEFAULT NULL;