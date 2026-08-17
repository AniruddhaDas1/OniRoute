// Shared types for the OniRoute Edge Functions.
//
// `src/types.ts` mirrors these for the browser. Keep the two in sync; the
// `npm run typecheck:functions` script exists specifically because an earlier
// drift here (a missing `embedding_model_name`) shipped unnoticed.

export interface ApiProvider {
  id: string;
  user_id: string;
  name: string;
  provider_type: 'openai' | 'anthropic' | 'google' | 'ollama' | 'custom';
  endpoint: string;
  base_url: string;
  model_name: string;
  embedding_model_name: string | null;
  priority: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export const PROVIDER_TYPES: ReadonlyArray<ApiProvider['provider_type']> = ['openai', 'anthropic', 'google', 'ollama', 'custom'];

export function isProviderType(value: unknown): value is ApiProvider['provider_type'] {
  return typeof value === 'string' && (PROVIDER_TYPES as ReadonlyArray<string>).includes(value);
}

export interface RoutingConfig {
  mode: 'priority' | 'random';
  failover_enabled: boolean;
  max_retries: number;
  timeout_ms: number;
  refine_prompt: string | null;
}

export type IngestStatus = 'pending' | 'queued' | 'processing' | 'complete' | 'error';

export interface IngestStats {
  attempts?: number;
  chunks_total?: number;
  chunks_embedded?: number;
  files_read?: number;
  files_skipped?: number;
  source_chars?: number;
  truncated?: boolean;
  truncation_reason?: string;
  warnings?: string[];
}

export interface KnowledgeBase {
  id: string;
  user_id: string;
  name: string;
  source_type: 'file' | 'repo' | 'text';
  source_url: string | null;
  source_content: string | null;
  embedding_provider_id: string | null;
  status: IngestStatus;
  error_message: string | null;
  chunk_count: number;
  ingest_started_at: string | null;
  ingest_completed_at: string | null;
  ingest_stats: IngestStats | null;
  created_at: string;
}

export type LogStatus = 'success' | 'error' | 'failover';

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface GatewayKey {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  max_context_tokens?: number | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

