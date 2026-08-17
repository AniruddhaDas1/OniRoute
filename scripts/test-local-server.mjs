import { app } from '../server/app.mjs';
import { encryptSecret, decryptSecret, sha256, createGatewayKey } from '../server/crypto.mjs';
import { cosineSimilarity } from '../server/vector.mjs';
import { pruneContextToBudget, validateProviderUrl, parseProviderStreamLine } from '../server/provider-client.mjs';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('  OniRoute Comprehensive Security & Gateway Test Suite');
  console.log('====================================================\n');

  // 1. Health check
  console.log('1. Testing Health Endpoint:');
  const healthRes = await app.fetch(new Request('http://localhost:1001/health'));
  assert(healthRes.status === 200, 'Health endpoint returns HTTP 200');
  const healthData = await healthRes.json();
  assert(healthData.status === 'ok', 'Health status payload is ok');
  console.log('');

  // 2. Cryptography & Vault
  console.log('2. Testing AES-256-GCM Cryptography:');
  const plainSecret = 'sk-ant-api-test-key-12345';
  const encrypted = encryptSecret(plainSecret);
  assert(encrypted.ciphertext && encrypted.iv && encrypted.tag, 'Secret is encrypted with ciphertext, iv, and tag');
  const decrypted = decryptSecret(encrypted.ciphertext, encrypted.iv, encrypted.tag);
  assert(decrypted === plainSecret, 'Secret is correctly decrypted to original plaintext');
  const sampleKey = createGatewayKey();
  assert(sampleKey.startsWith('or_'), 'createGatewayKey produces key with "or_" prefix');
  const hashed = sha256(sampleKey);
  assert(hashed.length === 64, 'sha256 produces 64-char hex digest');
  console.log('');

  // 3. Vector Search Engine
  console.log('3. Testing Vector Search Engine:');
  const v1 = [1, 0, 0];
  const v2 = [1, 0, 0];
  const v3 = [0, 1, 0];
  assert(Math.abs(cosineSimilarity(v1, v2) - 1.0) < 0.0001, 'Identical vectors have cosine similarity of 1.0');
  assert(Math.abs(cosineSimilarity(v1, v3) - 0.0) < 0.0001, 'Orthogonal vectors have cosine similarity of 0.0');

  const largeA = Array.from({ length: 1536 }, () => Math.random());
  const largeB = Array.from({ length: 1536 }, () => Math.random());
  const start = performance.now();
  const sim = cosineSimilarity(largeA, largeB);
  const dur = performance.now() - start;
  assert(dur < 2.0 && typeof sim === 'number', `1536-dim cosine similarity computed in ${dur.toFixed(3)}ms (< 2ms)`);
  console.log('');

  // 4. REST Endpoints & Key Context Isolation
  console.log('4. Testing REST Control Plane & Isolated Context Windows:');
  const modelsRes = await app.fetch(new Request('http://localhost:1001/v1/models'));
  assert(modelsRes.status === 200, 'GET /v1/models returns HTTP 200');
  const modelsData = await modelsRes.json();
  assert(modelsData.object === 'list', 'Models list conforms to OpenAI schema');

  const keyName = `Gemma Key ${Date.now()}`;
  const makeKeyRes = await app.fetch(
    new Request('http://localhost:1001/gateway-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', host: 'localhost:1001' },
      body: JSON.stringify({ name: keyName, max_context_tokens: 256000 }),
    }),
  );
  assert(makeKeyRes.status === 201, 'POST /gateway-keys creates a new key with 256K context (HTTP 201)');
  const keyData = await makeKeyRes.json();
  const createdApiKey = keyData.data?.key;
  assert(createdApiKey?.startsWith('or_'), 'Generated key has "or_" prefix');

  // Verify context window trimming helper
  const sys = ['You are a codebase architect.'];
  const turns = [
    { role: 'user', content: 'Turn 1: Oldest codebase context...' },
    { role: 'assistant', content: 'Turn 2: Analysis of old code.' },
    { role: 'user', content: 'Turn 3: Most recent user command.' },
  ];
  const pruned = pruneContextToBudget(sys, turns, 20);
  assert(pruned.length >= 2, 'pruneContextToBudget keeps system instruction and latest user turn');
  assert(pruned[pruned.length - 1].content === 'Turn 3: Most recent user command.', 'Latest query is strictly protected during context trimming');
  console.log('');

  // 5. P0 Security: Inference Authentication
  console.log('5. Testing Inference Authentication:');
  const unauthChatRes = await app.fetch(
    new Request('http://localhost:1001/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
    }),
  );
  assert(unauthChatRes.status === 401, 'Unauthenticated POST /v1/chat/completions returns HTTP 401 Unauthorized');

  const invalidKeyRes = await app.fetch(
    new Request('http://localhost:1001/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer or_invalid_key_1234567890abcdef',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
    }),
  );
  assert(invalidKeyRes.status === 401, 'Invalid gateway key returns HTTP 401');
  console.log('');

  // 6. P0 Security: Strict Domain Boundary Validation (Finding A)
  console.log('6. Testing Finding A — Strict Domain Boundary & Lookalike Attack Prevention:');
  const maliciousLookalikes = [
    { type: 'openai', url: 'https://evilopenai.com/v1/chat' },
    { type: 'openai', url: 'https://notopenai.com/v1' },
    { type: 'openai', url: 'https://fakeazure.com/v1' },
    { type: 'anthropic', url: 'https://evilanthropic.com/v1' },
    { type: 'anthropic', url: 'https://attacker-anthropic.com' },
    { type: 'google', url: 'https://evilgoogleapis.com/v1' },
    { type: 'google', url: 'https://fake-googleapis.com/v1' },
  ];

  for (const item of maliciousLookalikes) {
    let threw = false;
    try {
      validateProviderUrl({ provider_type: item.type, base_url: item.url, endpoint: '' }, true);
    } catch {
      threw = true;
    }
    assert(threw, `Malicious domain "${item.url}" for provider "${item.type}" is strictly REJECTED`);
  }

  // Legitimate domains must pass
  const legitDomains = [
    { type: 'openai', url: 'https://api.openai.com/v1' },
    { type: 'openai', url: 'https://myorg.openai.azure.com/v1' },
    { type: 'anthropic', url: 'https://api.anthropic.com/v1' },
    { type: 'google', url: 'https://generativelanguage.googleapis.com/v1' },
    { type: 'ollama', url: 'https://ollama.com/api' },
  ];

  for (const item of legitDomains) {
    let threw = false;
    try {
      validateProviderUrl({ provider_type: item.type, base_url: item.url, endpoint: '' }, true);
    } catch {
      threw = true;
    }
    assert(!threw, `Legitimate domain "${item.url}" for provider "${item.type}" is correctly ACCEPTED`);
  }
  console.log('');

  // 7. P0 Security: Standalone Control Plane Authentication (Finding B)
  console.log('7. Testing Finding B — Standalone Control Plane Authentication Boundary:');
  const remoteHeaders = { 'Content-Type': 'application/json', host: '192.168.1.50:1001' };

  const remoteGetProvidersRes = await app.fetch(
    new Request('http://192.168.1.50:1001/providers', { headers: remoteHeaders }),
  );
  assert(remoteGetProvidersRes.status === 401, 'Remote unauthenticated GET /providers is rejected with HTTP 401');

  const remoteGetSecretRes = await app.fetch(
    new Request('http://192.168.1.50:1001/providers/p1/secret', { headers: remoteHeaders }),
  );
  assert(remoteGetSecretRes.status === 401, 'Remote unauthenticated GET /providers/:id/secret is rejected with HTTP 401');

  const remoteGetKeysRes = await app.fetch(
    new Request('http://192.168.1.50:1001/gateway-keys', { headers: remoteHeaders }),
  );
  assert(remoteGetKeysRes.status === 401, 'Remote unauthenticated GET /gateway-keys is rejected with HTTP 401');

  const remoteGetMembersRes = await app.fetch(
    new Request('http://192.168.1.50:1001/admin/members', { headers: remoteHeaders }),
  );
  assert(remoteGetMembersRes.status === 401, 'Remote unauthenticated GET /admin/members is rejected with HTTP 401');

  // Authenticated remote request with gateway key
  const authRemoteRes = await app.fetch(
    new Request('http://192.168.1.50:1001/providers', {
      headers: { ...remoteHeaders, Authorization: `Bearer ${createdApiKey}` },
    }),
  );
  assert(authRemoteRes.status === 200, 'Authenticated remote GET /providers with valid key returns HTTP 200');
  console.log('');

  // 8. P1: Real Upstream Stream Line Parser (Finding C)
  console.log('8. Testing Finding C — Upstream Stream Line Parsing Engine:');
  const openaiDelta = parseProviderStreamLine(
    { provider_type: 'openai' },
    'data: {"choices":[{"delta":{"content":"Hello world"},"finish_reason":null}]}',
  );
  assert(openaiDelta?.text === 'Hello world' && openaiDelta.finishReason === null, 'OpenAI SSE chunk correctly parsed to text delta');

  const anthropicDelta = parseProviderStreamLine(
    { provider_type: 'anthropic' },
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" Claude response"}}',
  );
  assert(anthropicDelta?.text === ' Claude response', 'Anthropic content_block_delta parsed to text delta');

  const googleDelta = parseProviderStreamLine(
    { provider_type: 'google' },
    'data: {"candidates":[{"content":{"parts":[{"text":" Gemini text"}]}}]}',
  );
  assert(googleDelta?.text === ' Gemini text', 'Google streamGenerateContent chunk parsed to text delta');

  const ollamaDelta = parseProviderStreamLine(
    { provider_type: 'ollama' },
    '{"model":"llama3","message":{"role":"assistant","content":" Ollama token"},"done":false}',
  );
  assert(ollamaDelta?.text === ' Ollama token', 'Ollama newline-delimited JSON parsed to text delta');
  console.log('');

  // 9. SSRF Protection on Cloud Mode (Finding D)
  console.log('9. Testing Finding D — Cloud Mode SSRF Protection:');
  const ssrfTargets = [
    'http://169.254.169.254/latest/meta-data',
    'http://127.0.0.1:54321',
    'http://localhost:1001',
    'http://10.0.0.1:8080',
    'http://192.168.1.1/admin',
  ];

  for (const target of ssrfTargets) {
    let threw = false;
    try {
      validateProviderUrl({ provider_type: 'custom', base_url: target, endpoint: '' }, true);
    } catch {
      threw = true;
    }
    assert(threw, `SSRF target "${target}" is blocked in Cloud mode`);
  }
  console.log('');

  console.log('====================================================');
  console.log(`  Tests Complete: ${passed} Passed, ${failed} Failed`);
  console.log('====================================================');

  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
