#!/usr/bin/env npx tsx
/**
 * Encrypt a wallet secret for at-rest storage.
 *
 * Uses AES-256-GCM with scrypt key derivation — same parameters as
 * the decryptSecret() function in bot-config.ts.
 *
 * Usage:
 *   # From stdin:
 *   echo '0xYOUR_PRIVATE_KEY' | WALLET_MASTER_KEY=mypassphrase npx tsx scripts/encrypt-secret.ts
 *
 *   # From file:
 *   WALLET_MASTER_KEY=mypassphrase npx tsx scripts/encrypt-secret.ts --input secrets/evm_key.txt
 *
 *   # Write to secret file:
 *   echo '0x...' | WALLET_MASTER_KEY=mypassphrase npx tsx scripts/encrypt-secret.ts > secrets/evm_private_key
 *
 * Output is prefixed with "enc:" so readSecret() auto-detects encrypted values.
 *
 * To decrypt (verify round-trip):
 *   WALLET_MASTER_KEY=mypassphrase npx tsx scripts/encrypt-secret.ts --decrypt --input secrets/evm_private_key
 */

import crypto from 'crypto';
import fs from 'fs';

const SALT_LEN = 32;
const IV_LEN = 16;
const SCRYPT_N = 16384; // 2^14 — must match bot-config.ts
const KEY_LEN = 32;
const MAGIC = 'enc:';

function encrypt(plaintext: string, passphrase: string): string {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = crypto.scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: 8, p: 1 });
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([salt, iv, tag, encrypted]);
  return MAGIC + combined.toString('base64');
}

function decrypt(blob: string, passphrase: string): string {
  const combined = Buffer.from(blob.slice(MAGIC.length), 'base64');
  const salt = combined.subarray(0, SALT_LEN);
  const iv = combined.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag = combined.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + 16);
  const ciphertext = combined.subarray(SALT_LEN + IV_LEN + 16);
  const key = crypto.scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: 8, p: 1 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}

// --- CLI ---

const passphrase = process.env.WALLET_MASTER_KEY;
if (!passphrase) {
  console.error('Error: Set WALLET_MASTER_KEY env var');
  process.exit(1);
}

const isDecrypt = process.argv.includes('--decrypt');
const inputIdx = process.argv.indexOf('--input');
let input: string;

if (inputIdx !== -1 && process.argv[inputIdx + 1]) {
  input = fs.readFileSync(process.argv[inputIdx + 1], 'utf8').trim();
} else {
  input = fs.readFileSync('/dev/stdin', 'utf8').trim();
}

if (isDecrypt) {
  if (!input.startsWith(MAGIC)) {
    console.error('Error: Input does not look encrypted (missing "enc:" prefix)');
    process.exit(1);
  }
  console.log(decrypt(input, passphrase));
} else {
  console.log(encrypt(input, passphrase));
}
