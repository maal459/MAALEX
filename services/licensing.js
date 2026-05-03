/**
 * Serverless license verification using Ed25519 asymmetric signatures.
 *
 * - The PRIVATE key never leaves the developer's machine.
 * - The PUBLIC key below is safe to ship in the app — it can only verify,
 *   never forge.
 * - Each license is bound to a specific deviceId so keys cannot be shared.
 *
 * License key format:
 *   MAALEX.{base64url(JSON payload)}.{base64url(Ed25519 signature)}
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDeviceId, getCachedDeviceId } from './deviceId';

// Configure pure-JS sha512 so ed.sync.verify works in React Native
// (Hermes does not expose crypto.subtle)
ed.utils.sha512Sync = (...msgs) => {
  const h = sha512.create();
  for (const m of msgs) h.update(m);
  return h.digest();
};

// ─── Public key — safe to embed in app ───────────────────────────────────────
const PUBLIC_KEY_HEX = '67a61b15bb113eb3751605a9ab0b8bac771e8914575c5f49b06e0c0372708986';

// ─── Trial config ─────────────────────────────────────────────────────────────
const TRIAL_DURATION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const TRIAL_STORAGE_KEY = '@maalex/trial-start';
export const LICENSE_STORAGE_KEY = '@maalex/license-key';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const hexToBytes = (hex) => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

const b64urlToBytes = (str) => {
  // base64url → base64 with required padding
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const bytesToB64url = (bytes) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
};

// ─── Core verification ────────────────────────────────────────────────────────

/**
 * Verify a license key string offline.
 * Returns { ok, license } or { ok: false, reason }.
 */
export const verifyLicense = async (keyString) => {
  try {
    const parts = String(keyString || '').trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'MAALEX') {
      return { ok: false, reason: 'Invalid license format.' };
    }

    const [, payloadB64, sigB64] = parts;

    // Verify Ed25519 signature (sync path — works in React Native/Hermes)
    const payloadBytes = new TextEncoder().encode(payloadB64);
    const sigBytes = b64urlToBytes(sigB64);
    const pubKeyBytes = hexToBytes(PUBLIC_KEY_HEX);

    const valid = ed.sync.verify(sigBytes, payloadBytes, pubKeyBytes);
    if (!valid) {
      return { ok: false, reason: 'License signature is invalid.' };
    }

    // Decode payload
    const payload = JSON.parse(
      new TextDecoder().decode(b64urlToBytes(payloadB64))
    );

    // Check expiry
    if (payload.expiresAt && Date.now() > payload.expiresAt) {
      return { ok: false, reason: 'License has expired.' };
    }

    // Check device binding
    const deviceId = getCachedDeviceId() || (await getDeviceId());
    if (payload.deviceId && payload.deviceId !== '*' && payload.deviceId !== deviceId) {
      return { ok: false, reason: 'License is bound to a different device.' };
    }

    return {
      ok: true,
      license: {
        key: keyString,
        tier: payload.tier || 'full',
        deviceId: payload.deviceId,
        expiresAt: payload.expiresAt ? new Date(payload.expiresAt).toISOString() : null,
        label: payload.label || null,
      },
    };
  } catch (err) {
    return { ok: false, reason: 'License verification failed.' };
  }
};

// ─── Trial license (purely local, no server) ──────────────────────────────────

/**
 * Start or resume a local 3-day trial. No server needed.
 * Returns { ok, license } or { ok: false, reason }.
 */
export const getOrStartTrial = async () => {
  try {
    const deviceId = getCachedDeviceId() || (await getDeviceId());
    let trialStart = null;

    const stored = await AsyncStorage.getItem(TRIAL_STORAGE_KEY);
    if (stored) {
      trialStart = parseInt(stored, 10);
    } else {
      trialStart = Date.now();
      await AsyncStorage.setItem(TRIAL_STORAGE_KEY, String(trialStart));
    }

    const expiresAt = trialStart + TRIAL_DURATION_MS;
    if (Date.now() > expiresAt) {
      return { ok: false, reason: 'Free trial has expired. Please purchase a license.' };
    }

    return {
      ok: true,
      license: {
        key: 'TRIAL',
        tier: 'trial',
        deviceId,
        expiresAt: new Date(expiresAt).toISOString(),
        label: 'Free Trial',
      },
    };
  } catch {
    return { ok: false, reason: 'Could not start trial.' };
  }
};

// ─── Persistence helpers ──────────────────────────────────────────────────────

export const loadStoredLicenseKey = async () => {
  try {
    return (await AsyncStorage.getItem(LICENSE_STORAGE_KEY)) || '';
  } catch {
    return '';
  }
};

export const persistLicenseKey = async (key) => {
  try {
    await AsyncStorage.setItem(LICENSE_STORAGE_KEY, String(key || '').trim());
  } catch {
    // in-memory fallback is fine
  }
};

export const clearLicenseKey = async () => {
  try {
    await AsyncStorage.removeItem(LICENSE_STORAGE_KEY);
  } catch {}
};
