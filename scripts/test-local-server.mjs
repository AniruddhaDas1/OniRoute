import { app } from '../server/app.mjs';
import { encryptSecret, decryptSecret, sha256, createGatewayKey } from '../server/crypto.mjs';
import { cosineSimilarity } from '../server/vector.mjs';

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
  console.log('  OniRoute Local Server Test Suite');
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

  // 3. Vector Cosine Similarity
  console.log('3. Testing Vector Search Engine:');
  const v1 = [1, 0, 0];
  const v2 = [1, 0, 0];
  const v3 = [0, 1, 0];
  assert(Math.abs(cosineSimilarity(v1, v2) - 1.0) < 0.0001, 'Identical vectors have cosine similarity of 1.0');
  assert(Math.abs(cosineSimilarity(v1, v3) - 0.0) < 0.0001, 'Orthogonal vectors have cosine similarity of 0.0');

  // Test 1536-dim vector performance
  const largeA = Array.from({ length: 1536 }, () => Math.random());
  const largeB = Array.from({ length: 1536 }, () => Math.random());
  const start = performance.now();
  const sim = cosineSimilarity(largeA, largeB);
  const dur = performance.now() - start;
  assert(dur < 1.0 && typeof sim === 'number', `1536-dim cosine similarity computed in ${dur.toFixed(3)}ms (< 1ms)`);
  console.log('');

  // 4. REST Endpoints
  console.log('4. Testing REST Control Plane:');
  const modelsRes = await app.fetch(new Request('http://localhost:1001/v1/models'));
  assert(modelsRes.status === 200, 'GET /v1/models returns HTTP 200');
  const modelsData = await modelsRes.json();
  assert(modelsData.object === 'list', 'Models list conforms to OpenAI schema');

  const routingRes = await app.fetch(new Request('http://localhost:1001/routing-config'));
  assert(routingRes.status === 200, 'GET /routing-config returns HTTP 200');

  const keyName = `Test Key ${Date.now()}`;
  const makeKeyRes = await app.fetch(
    new Request('http://localhost:1001/gateway-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: keyName }),
    }),
  );
  assert(makeKeyRes.status === 201, 'POST /gateway-keys creates a new key (HTTP 201)');
  const keyData = await makeKeyRes.json();
  assert(keyData.data?.key?.startsWith('or_'), 'Generated key has "or_" prefix');
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
