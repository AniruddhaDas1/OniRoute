import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data');
const KEY_FILE = join(DATA_DIR, '.secret_key');

function getMasterKey() {
  if (process.env.ONIROUTE_SECRET) {
    return createHash('sha256').update(process.env.ONIROUTE_SECRET).digest();
  }
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (existsSync(KEY_FILE)) {
    return readFileSync(KEY_FILE);
  }
  const key = randomBytes(32);
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}

const MASTER_KEY = getMasterKey();

export function encryptSecret(plainText) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    tag: authTag,
  };
}

export function decryptSecret(ciphertext, ivHex, tagHex) {
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', MASTER_KEY, iv);
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function createGatewayKey() {
  const bytes = randomBytes(24);
  return `or_${bytes.toString('hex')}`;
}
