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

/** `queued` means the worker has not picked the job up yet. */
export type IngestStatus = 'pending' | 'queued' | 'processing' | 'complete' | 'error';

/** Progress and diagnostics written by the `embed-knowledge` worker. */
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

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface RoutingConfig {
  id: string;
  user_id: string;
  mode: 'priority' | 'random';
  failover_enabled: boolean;
  max_retries: number;
  timeout_ms: number;
  refine_prompt: string | null;
  created_at: string;
}

export interface KnowledgeBase {
  id: string;
  user_id: string;
  name: string;
  source_type: 'file' | 'repo' | 'text';
  source_url: string | null;
  source_content?: string | null;
  embedding_provider_id?: string | null;
  error_message?: string | null;
  status: IngestStatus;
  chunk_count: number;
  ingest_started_at?: string | null;
  ingest_completed_at?: string | null;
  ingest_stats?: IngestStats | null;
  created_at: string;
}

export interface VectorChunk {
  id: string;
  user_id: string;
  knowledge_base_id: string;
  content: string;
  metadata: Record<string, any>;
  created_at: string;
}

export interface RequestLog {
  id: string;
  user_id: string;
  provider_id: string;
  status: 'success' | 'error' | 'failover';
  latency_ms: number;
  error_message: string | null;
  mode: 'direct' | 'refined';
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  created_at: string;
}

/** Shape of `GET /logs`, which is keyset-paginated. */
export interface LogPage {
  logs: RequestLog[];
  next_cursor: string | null;
}

export interface ProviderGroup {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  routing_mode: 'priority' | 'random';
  provider_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface GatewayKey {
  id: string;
  user_id?: string;
  name: string;
  key_prefix: string;
  provider_group_id?: string | null;
  provider_group_name?: string | null;
  routing_mode?: 'priority' | 'random' | null;
  gateway_mode?: 'direct' | 'refined' | 'flexible' | null;
  selected_provider_ids?: string[] | null;
  max_context_tokens?: number | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export type UserRole = 'super_admin' | 'admin' | 'member';

export interface UserProfile {
  id: string;
  email: string;
  role: UserRole;
  is_active: boolean;
  access_granted: boolean;
  created_at: string;
  updated_at: string;
}

export interface AdminMember extends UserProfile {
  providers_count?: number;
  keys_count?: number;
  knowledge_count?: number;
  total_requests?: number;
}

