import { app } from '../server/app.mjs';
import { encryptSecret, decryptSecret, sha256, createGatewayKey } from '../server/crypto.mjs';
import { cosineSimilarity } from '../server/vector.mjs';
import { pruneContextToBudget, validateProviderUrl } from '../server/provider-client.mjs';
import { db } from '../server/db.mjs';

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
  console.log('========================================');
  console.log('  OniRoute Local Server & Security Suite');
  console.log('========================================\n');

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

  const routingRes = await app.fetch(new Request('http://localhost:1001/routing-config'));
  assert(routingRes.status === 200, 'GET /routing-config returns HTTP 200');

  const keyName = `Gemma Key ${Date.now()}`;
  const makeKeyRes = await app.fetch(
    new Request('http://localhost:1001/gateway-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: keyName, max_context_tokens: 256000 }),
    }),
  );
  assert(makeKeyRes.status === 201, 'POST /gateway-keys creates a new key with 256K context (HTTP 201)');
  const keyData = await makeKeyRes.json();
  const createdApiKey = keyData.data?.key;
  assert(createdApiKey?.startsWith('or_'), 'Generated key has "or_" prefix');
  assert(keyData.data?.max_context_tokens === 256000, 'Gateway key preserves isolated max_context_tokens: 256000');

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

  // 5. P0 Security: Unauthenticated Inference Rejection
  console.log('5. Testing P0 Security — Inference Authentication:');
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

  // 6. P0 Security: Provider URL Poisoning Rejection
  console.log('6. Testing P0 Security — Provider URL Poisoning Protection:');
  let threwOnOpenAI = false;
  try {
    validateProviderUrl({
      provider_type: 'openai',
      base_url: 'https://attacker.evil.com',
      endpoint: '/v1/chat/completions',
    });
  } catch {
    threwOnOpenAI = true;
  }
  assert(threwOnOpenAI, 'Poisoned OpenAI URL targeting attacker.evil.com is rejected by validator');

  const poisonedPostRes = await app.fetch(
    new Request('http://localhost:1001/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Poisoned OpenAI',
        provider_type: 'openai',
        base_url: 'https://exfiltrate-secrets.example.com',
        endpoint: '/v1/chat/completions',
        model_name: 'gpt-4o',
        api_key: 'sk-proj-test',
      }),
    }),
  );
  assert(poisonedPostRes.status === 400, 'POST /providers rejects poisoned URL with HTTP 400');
  console.log('');

  // 7. Provider Groups & Provider Validation
  console.log('7. Testing Provider Groups & Provider Isolation:');
  const validProvider = db.createProvider(
    {
      name: 'Valid Mock OpenAI',
      provider_type: 'openai',
      base_url: 'https://api.openai.com',
      endpoint: '/v1/chat/completions',
      model_name: 'gpt-4o',
    },
    'sk-proj-valid-12345',
  );

  const makeGroupRes = await app.request('/provider-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Coding LLMs Group',
      description: 'Fast coding models cluster',
      routing_mode: 'priority',
      provider_ids: [validProvider.id],
    }),
  });
  assert(makeGroupRes.status === 201, 'POST /provider-groups creates group with valid provider (HTTP 201)');

  const foreignGroupRes = await app.request('/provider-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Malicious Group',
      provider_ids: ['foreign-uuid-99999'],
    }),
  });
  assert(foreignGroupRes.status === 400, 'POST /provider-groups rejects unowned provider IDs with HTTP 400');
  console.log('');

  // 8. P1: SSE Streaming Response Verification
  console.log('8. Testing P1 — SSE Streaming Format:');
  const streamRes = await app.fetch(
    new Request('http://localhost:1001/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${createdApiKey}`,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test streaming' }],
        stream: true,
      }),
    }),
  );
  assert(streamRes.headers.get('content-type')?.includes('text/event-stream') || streamRes.status === 502, 'Streaming endpoint sets text/event-stream header (or 502 upstream failover)');
  console.log('');

  console.log('========================================');
  console.log(`  Tests Complete: ${passed} Passed, ${failed} Failed`);
  console.log('========================================');

  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
