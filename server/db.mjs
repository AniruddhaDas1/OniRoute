import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encryptSecret, decryptSecret } from './crypto.mjs';

const DATA_DIR = join(process.cwd(), 'data');
const DB_FILE = join(DATA_DIR, 'oniroute_store.json');
const DB_BAK = join(DATA_DIR, 'oniroute_store.json.bak');
const DB_TMP = join(DATA_DIR, 'oniroute_store.json.tmp');

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

export const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000000';

function loadState() {
  if (existsSync(DB_FILE)) {
    try {
      const data = readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      console.error(`[db] Primary store corrupt (${err.message}). Attempting recovery from backup...`);
      if (existsSync(DB_BAK)) {
        try {
          const bakData = readFileSync(DB_BAK, 'utf8');
          const recovered = JSON.parse(bakData);
          console.warn('[db] Successfully recovered state from oniroute_store.json.bak.');
          return recovered;
        } catch (bakErr) {
          console.error(`[db] Backup file also unreadable (${bakErr.message}).`);
        }
      }
      const corruptFile = join(DATA_DIR, `oniroute_store.json.corrupt.${Date.now()}`);
      try {
        renameSync(DB_FILE, corruptFile);
        console.warn(`[db] Preserved corrupt database as ${corruptFile}`);
      } catch (renameErr) {
        void renameErr;
      }
      throw new Error(`Database file is corrupted. Preserved as backup. ${err.message}`);
    }
  }

  return {
    providers: [],
    provider_groups: [],
    vault_secrets: {},
    routing_config: {
      mode: 'priority',
      failover_enabled: true,
      max_retries: 3,
      timeout_ms: 10000,
      refine_prompt: null,
    },
    gateway_keys: [],
    knowledge_bases: [],
    vector_chunks: [],
    request_logs: [],
  };
}

let state = loadState();

function persist() {
  const json = JSON.stringify(state, null, 2);
  // Atomic write pattern: write to tmp file, flush, then rename
  writeFileSync(DB_TMP, json, 'utf8');
  if (existsSync(DB_FILE)) {
    try {
      copyFileSync(DB_FILE, DB_BAK);
    } catch (copyErr) {
      void copyErr;
    }
  }
  renameSync(DB_TMP, DB_FILE);
}

export const db = {
  // --- Providers ---
  getProviders(userId = LOCAL_USER_ID) {
    return state.providers
      .filter((p) => p.user_id === userId)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  },

  getProviderById(id, userId = LOCAL_USER_ID) {
    return state.providers.find((p) => p.id === id && p.user_id === userId) ?? null;
  },

  createProvider(data, apiKey) {
    const id = randomUUID();
    const highestPriority = state.providers.reduce((max, p) => Math.max(max, p.priority ?? 0), -1);
    const provider = {
      id,
      user_id: data.user_id || LOCAL_USER_ID,
      name: data.name,
      provider_type: data.provider_type,
      base_url: data.base_url,
      endpoint: data.endpoint,
      model_name: data.model_name,
      embedding_model_name: data.embedding_model_name || null,
      priority: highestPriority + 1,
      is_active: data.is_active ?? true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    state.providers.push(provider);
    if (apiKey) {
      state.vault_secrets[id] = encryptSecret(apiKey);
    }
    persist();
    return provider;
  },

  updateProvider(id, updates, apiKey, userId = LOCAL_USER_ID) {
    const provider = state.providers.find((p) => p.id === id && p.user_id === userId);
    if (!provider) return null;
    Object.assign(provider, updates, { updated_at: new Date().toISOString() });
    if (apiKey) {
      state.vault_secrets[id] = encryptSecret(apiKey);
    }
    persist();
    return provider;
  },

  deleteProvider(id, userId = LOCAL_USER_ID) {
    const index = state.providers.findIndex((p) => p.id === id && p.user_id === userId);
    if (index === -1) return false;
    state.providers.splice(index, 1);
    delete state.vault_secrets[id];
    persist();
    return true;
  },

  reorderProviders(providerIds, userId = LOCAL_USER_ID) {
    providerIds.forEach((id, priority) => {
      const provider = state.providers.find((p) => p.id === id && p.user_id === userId);
      if (provider) provider.priority = priority;
    });
    persist();
  },

  getProviderSecret(providerId) {
    const secret = state.vault_secrets[providerId];
    if (!secret) return null;
    try {
      return decryptSecret(secret.ciphertext, secret.iv, secret.tag);
    } catch {
      return null;
    }
  },

  // --- Routing Config ---
  getRoutingConfig(userId = LOCAL_USER_ID) {
    return { user_id: userId, ...state.routing_config };
  },

  updateRoutingConfig(updates, userId = LOCAL_USER_ID) {
    state.routing_config = { ...state.routing_config, ...updates };
    persist();
    return { user_id: userId, ...state.routing_config };
  },

  // --- Provider Groups ---
  getProviderGroups(userId = LOCAL_USER_ID) {
    if (!Array.isArray(state.provider_groups)) state.provider_groups = [];
    return state.provider_groups
      .filter((g) => g.user_id === userId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  },

  getProviderGroupById(id, userId = LOCAL_USER_ID) {
    if (!Array.isArray(state.provider_groups)) state.provider_groups = [];
    return state.provider_groups.find((g) => g.id === id && g.user_id === userId) ?? null;
  },

  createProviderGroup(data, userId = LOCAL_USER_ID) {
    if (!Array.isArray(state.provider_groups)) state.provider_groups = [];
    const group = {
      id: randomUUID(),
      user_id: userId,
      name: data.name?.trim() || 'Custom Group',
      description: data.description?.trim() || null,
      routing_mode: data.routing_mode === 'random' ? 'random' : 'priority',
      provider_ids: Array.isArray(data.provider_ids) ? data.provider_ids : [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    state.provider_groups.push(group);
    persist();
    return group;
  },

  updateProviderGroup(id, updates, userId = LOCAL_USER_ID) {
    if (!Array.isArray(state.provider_groups)) state.provider_groups = [];
    const group = state.provider_groups.find((g) => g.id === id && g.user_id === userId);
    if (!group) return null;
    if (updates.name) group.name = updates.name.trim();
    if (updates.description !== undefined) group.description = updates.description?.trim() || null;
    if (updates.routing_mode) group.routing_mode = updates.routing_mode;
    if (Array.isArray(updates.provider_ids)) group.provider_ids = updates.provider_ids;
    group.updated_at = new Date().toISOString();
    persist();
    return group;
  },

  deleteProviderGroup(id, userId = LOCAL_USER_ID) {
    if (!Array.isArray(state.provider_groups)) state.provider_groups = [];
    const index = state.provider_groups.findIndex((g) => g.id === id && g.user_id === userId);
    if (index === -1) return false;
    state.provider_groups.splice(index, 1);
    persist();
    return true;
  },

  // --- Gateway Keys ---
  getGatewayKeys(userId = LOCAL_USER_ID) {
    if (!Array.isArray(state.provider_groups)) state.provider_groups = [];
    const groupsMap = new Map(state.provider_groups.map((g) => [g.id, g.name]));
    return state.gateway_keys
      .filter((k) => k.user_id === userId)
      .map((k) => ({
        ...k,
        provider_group_name: k.provider_group_id ? groupsMap.get(k.provider_group_id) || null : null,
      }))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  },

  getGatewayKeyByHash(keyHash) {
    return state.gateway_keys.find((k) => k.key_hash === keyHash && !k.revoked_at) ?? null;
  },

  createGatewayKey(name, keyPrefix, keyHash, userId = LOCAL_USER_ID, maxContextTokens = null, options = {}) {
    const key = {
      id: randomUUID(),
      user_id: userId,
      name: name || 'Default key',
      key_prefix: keyPrefix,
      key_hash: keyHash,
      provider_group_id: options.provider_group_id || null,
      routing_mode: options.routing_mode || null,
      gateway_mode: options.gateway_mode || 'flexible',
      selected_provider_ids: Array.isArray(options.selected_provider_ids) ? options.selected_provider_ids : null,
      max_context_tokens: maxContextTokens ? Number(maxContextTokens) : null,
      last_used_at: null,
      revoked_at: null,
      created_at: new Date().toISOString(),
    };
    state.gateway_keys.push(key);
    persist();
    return key;
  },

  touchGatewayKey(id) {
    const key = state.gateway_keys.find((k) => k.id === id);
    if (key) {
      key.last_used_at = new Date().toISOString();
      persist();
    }
  },

  revokeGatewayKey(id, userId = LOCAL_USER_ID) {
    const key = state.gateway_keys.find((k) => k.id === id && k.user_id === userId);
    if (!key) return false;
    key.revoked_at = new Date().toISOString();
    persist();
    return true;
  },

  // --- Knowledge Bases ---
  getKnowledgeBases(userId = LOCAL_USER_ID) {
    return state.knowledge_bases
      .filter((k) => k.user_id === userId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  },

  getKnowledgeBaseById(id, userId = LOCAL_USER_ID) {
    return state.knowledge_bases.find((k) => k.id === id && k.user_id === userId) ?? null;
  },

  createKnowledgeBase(data, userId = LOCAL_USER_ID) {
    const kb = {
      id: randomUUID(),
      user_id: userId,
      name: data.name,
      source_type: data.source_type,
      source_url: data.source_url || null,
      source_content: data.content || null,
      embedding_provider_id: data.embedding_provider_id || null,
      status: 'pending',
      error_message: null,
      chunk_count: 0,
      ingest_started_at: null,
      ingest_completed_at: null,
      ingest_stats: {},
      created_at: new Date().toISOString(),
    };
    state.knowledge_bases.push(kb);
    persist();
    return kb;
  },

  updateKnowledgeBase(id, updates, userId = LOCAL_USER_ID) {
    const kb = state.knowledge_bases.find((k) => k.id === id && k.user_id === userId);
    if (!kb) return null;
    Object.assign(kb, updates);
    persist();
    return kb;
  },

  deleteKnowledgeBase(id, userId = LOCAL_USER_ID) {
    const index = state.knowledge_bases.findIndex((k) => k.id === id && k.user_id === userId);
    if (index === -1) return false;
    state.knowledge_bases.splice(index, 1);
    state.vector_chunks = state.vector_chunks.filter((c) => c.knowledge_base_id !== id);
    persist();
    return true;
  },

  // --- Vector Chunks ---
  replaceVectorChunks(kbId, chunks, userId = LOCAL_USER_ID) {
    state.vector_chunks = state.vector_chunks.filter((c) => c.knowledge_base_id !== kbId);
    for (const chunk of chunks) {
      state.vector_chunks.push({
        id: randomUUID(),
        user_id: userId,
        knowledge_base_id: kbId,
        content: chunk.content,
        embedding: chunk.embedding,
        metadata: chunk.metadata || {},
        created_at: new Date().toISOString(),
      });
    }
    persist();
  },

  getVectorChunksForSearch(userId = LOCAL_USER_ID, kbId = null) {
    return state.vector_chunks.filter(
      (c) => c.user_id === userId && (!kbId || c.knowledge_base_id === kbId) && Array.isArray(c.embedding),
    );
  },

  // --- Request Logs ---
  getLogs(userId = LOCAL_USER_ID, limit = 50, statusFilter = null) {
    let logs = state.request_logs.filter((l) => l.user_id === userId);
    if (statusFilter) logs = logs.filter((l) => l.status === statusFilter);
    return logs
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);
  },

  writeLog(logData) {
    const log = {
      id: randomUUID(),
      user_id: logData.user_id || LOCAL_USER_ID,
      provider_id: logData.provider_id || null,
      status: logData.status,
      latency_ms: logData.latency_ms ?? null,
      error_message: logData.error_message || null,
      mode: logData.mode || 'direct',
      prompt_tokens: logData.usage?.prompt_tokens ?? null,
      completion_tokens: logData.usage?.completion_tokens ?? null,
      total_tokens: logData.usage?.total_tokens ?? null,
      created_at: new Date().toISOString(),
    };
    state.request_logs.push(log);
    // Keep max 5,000 logs in memory/disk
    if (state.request_logs.length > 5000) {
      state.request_logs = state.request_logs.slice(-5000);
    }
    persist();
    return log;
  },

  // --- Members / Super Admin ---
  getMembers() {
    if (!state.profiles || !state.profiles.length) {
      state.profiles = [
        {
          id: LOCAL_USER_ID,
          email: 'leadspree24x7@gmail.com',
          role: 'super_admin',
          is_active: true,
          access_granted: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];
      persist();
    }
    return state.profiles.map((p) => {
      const isSuper = p.role === 'super_admin' || p.email?.toLowerCase() === 'leadspree24x7@gmail.com';
      return {
        ...p,
        role: isSuper ? 'super_admin' : (p.role ?? 'member'),
        providers_count: state.providers.filter((pr) => pr.user_id === p.id).length,
        keys_count: state.gateway_keys.filter((k) => k.user_id === p.id && !k.revoked_at).length,
        knowledge_count: state.knowledge_bases.filter((kb) => kb.user_id === p.id).length,
        total_requests: state.request_logs.filter((rl) => rl.user_id === p.id).length,
      };
    });
  },

  updateMember(id, updates) {
    if (!state.profiles) state.profiles = [];
    let profile = state.profiles.find((p) => p.id === id);
    if (!profile && id === LOCAL_USER_ID) {
      profile = {
        id: LOCAL_USER_ID,
        email: 'leadspree24x7@gmail.com',
        role: 'super_admin',
        is_active: true,
        access_granted: true,
        created_at: new Date().toISOString(),
      };
      state.profiles.push(profile);
    }
    if (!profile) return null;
    if (profile.email?.toLowerCase() === 'leadspree24x7@gmail.com') {
      if (updates.role && updates.role !== 'super_admin') throw new Error('Cannot demote root Super Admin.');
      if (updates.is_active === false || updates.access_granted === false) throw new Error('Cannot suspend root Super Admin.');
    }
    Object.assign(profile, updates, { updated_at: new Date().toISOString() });
    persist();
    return profile;
  },
};
