#!/usr/bin/env node
/**
 * MAALEX License Issuer — standalone, no server needed.
 *
 * Usage:
 *   node tools/issue-license.js <deviceId> [days] [tier] [label]
 *
 * Examples:
 *   node tools/issue-license.js lrfq3k-abc123def456  365
 *   node tools/issue-license.js lrfq3k-abc123def456  30  full  "Abdi Shop"
 *   node tools/issue-license.js "*"                  365       "Floating key"
 *
 * The deviceId shown to the customer is on the app's License screen.
 * Use "*" to issue a floating key not bound to any device (not recommended).
 *
 * Private key MUST be supplied via the MAALEX_LICENSE_PRIVATE_KEY env var
 * (or set in the project root .env, which is gitignored). It must NEVER be
 * committed to source control — anyone with it can mint valid licenses.
 *
 * The matching PUBLIC_KEY_HEX below is embedded in services/licensing.js
 * and is safe to commit.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Public key — safe to commit, matches services/licensing.js ──────────────
const PUBLIC_KEY_HEX = '8cf7c96b341ed916546d2d2e5c23427b9154c143c00cbc81e1480e6c82298bd1';

// ─── Private key — pulled from env, falling back to project-root .env ────────
const loadEnvKey = (name) => {
  if (process.env[name]) return process.env[name].trim();
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const envPath = path.resolve(here, '..', '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    const re = new RegExp('^\\s*' + name + '\\s*=\\s*(.+?)\\s*$', 'm');
    const m = content.match(re);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    // .env missing or unreadable — that's fine, env var path may still work.
  }
  return '';
};

const PRIVATE_KEY_HEX = loadEnvKey('MAALEX_LICENSE_PRIVATE_KEY');

if (!PRIVATE_KEY_HEX || !/^[0-9a-f]{64}$/i.test(PRIVATE_KEY_HEX)) {
  console.error('ERROR: MAALEX_LICENSE_PRIVATE_KEY not set or not a 64-char hex string.');
  console.error('');
  console.error('Set it one of two ways:');
  console.error('  PowerShell:  $env:MAALEX_LICENSE_PRIVATE_KEY = "<64-hex>"');
  console.error('  bash/zsh:    export MAALEX_LICENSE_PRIVATE_KEY=<64-hex>');
  console.error('  or put       MAALEX_LICENSE_PRIVATE_KEY=<64-hex>');
  console.error('  in the project-root .env file (gitignored).');
  process.exit(1);
}

// ─── Args: <deviceId> [days] [tier] [label] ───────────────────────────────────
const [,, deviceId, daysArg = '365', tier = 'full', ...labelParts] = process.argv;
const label = labelParts.join(' ');

if (!deviceId) {
  console.error('Usage: node tools/issue-license.js <deviceId> [days] [tier] [label]');
  console.error('Example: node tools/issue-license.js abc123 365 full "Abdi Shop"');
  process.exit(1);
}

const days = Math.max(1, parseInt(daysArg, 10) || 365);

// ─── Build payload ────────────────────────────────────────────────────────────
const payload = {
  deviceId,
  tier,
  issuedAt: Date.now(),
  expiresAt: Date.now() + days * 24 * 60 * 60 * 1000,
  ...(label ? { label } : {}),
};

const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

// ─── Sign with Ed25519 ────────────────────────────────────────────────────────
const privKeyDer = Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'),
  Buffer.from(PRIVATE_KEY_HEX, 'hex'),
]);
const privateKey = crypto.createPrivateKey({ key: privKeyDer, format: 'der', type: 'pkcs8' });
const signature = crypto.sign(null, Buffer.from(payloadB64), privateKey);
const sigB64 = signature.toString('base64url');
const licenseKey = `MAALEX.${payloadB64}.${sigB64}`;

// ─── Self-verify (catches mismatched public/private keys early) ──────────────
const pubKeyDer = Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  Buffer.from(PUBLIC_KEY_HEX, 'hex'),
]);
const publicKey = crypto.createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });
if (!crypto.verify(null, Buffer.from(payloadB64), publicKey, signature)) {
  console.error('ERROR: Self-verification failed — MAALEX_LICENSE_PRIVATE_KEY does not');
  console.error('match the embedded PUBLIC_KEY_HEX. Did you forget to update one of them?');
  process.exit(1);
}

// ─── Output ───────────────────────────────────────────────────────────────────
console.log('\nLicense key generated:\n');
console.log('─'.repeat(64));
console.log(licenseKey);
console.log('─'.repeat(64));
console.log(`Device:   ${payload.deviceId}`);
console.log(`Tier:     ${payload.tier}`);
console.log(`Expires:  ${new Date(payload.expiresAt).toISOString()} (${days} days)`);
if (label) console.log(`Label:    ${label}`);
console.log();
