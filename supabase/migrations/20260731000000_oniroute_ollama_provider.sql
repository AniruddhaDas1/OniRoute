-- =============================================================================
-- OniRoute Ollama Provider Support Migration
-- =============================================================================
-- Extends the provider_type domain to natively include 'ollama'.
-- =============================================================================

ALTER TABLE public.ai_providers DROP CONSTRAINT IF EXISTS ai_providers_provider_type_check;
ALTER TABLE public.ai_providers
  ADD CONSTRAINT ai_providers_provider_type_check
  CHECK (provider_type IN ('openai', 'anthropic', 'google', 'ollama', 'custom'));
