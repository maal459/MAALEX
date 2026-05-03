import crypto from 'node:crypto';

const PREFIX = 'MAALEX';
const SEP = '.';
const SIG_BYTES = 16;
const TRIAL_DURATION_MS = 3 * 24 * 60 * 60 * 1000;
const ANY_DEVICE = '*';

// ─── Ed25519 public key (same key embedded in the app) ────────────────────────
const ED25519_PUBLIC_HEX = '67a61b15bb113eb3751605a9ab0b8bac771e8914575c5f49b06e0c0372708986';
const _ed25519PubDer = Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  Buffer.from(ED25519_PUBLIC_HEX, 'hex'),
]);
const ed25519PublicKey = crypto.createPublicKey({ key: _ed25519PubDer, format: 'der', type: 'spki' });

const verifyEd25519Sig = (payloadB64, sigB64) => {
  try {
    const sig = Buffer.from(String(sigB64), 'base64url');
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(String(payloadB64)), ed25519PublicKey, sig);
  } catch {
    return false;
  }
};

const getSecret = () => {
  const secret = process.env.LICENSE_SECRET;

  if (!secret || secret.length < 16) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'LICENSE_SECRET env var is required (32+ random chars) in production.'
      );
    }
    // Dev fallback so local runs work without configuration.
    return 'dev-only-secret-do-not-use-in-production-environments';
  }

  return secret;
};

const b64url = (buffer) => buffer.toString('base64url');
const fromB64url = (str) => Buffer.from(String(str), 'base64url');

const sign = (payloadB64) => {
  const mac = crypto.createHmac('sha256', getSecret());
  mac.update(payloadB64);
  return b64url(mac.digest().subarray(0, SIG_BYTES));
};

const constantTimeEq = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

export const issueLicense = ({
  tier = 'full',
  durationMs,
  deviceId,
  label,
} = {}) => {
  const now = Date.now();
  const exp =
    typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0
      ? now + durationMs
      : now + 365 * 24 * 60 * 60 * 1000; // default 1 year

  const payload = {
    t: tier,
    iat: now,
    exp,
    dev: deviceId ? String(deviceId) : ANY_DEVICE,
  };

  if (label) {
    payload.lbl = String(label);
  }

  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  const sigB64 = sign(payloadB64);

  return {
    key: `${PREFIX}${SEP}${payloadB64}${SEP}${sigB64}`,
    payload,
  };
};

export const issueTrialLicense = (deviceId) => {
  if (!deviceId || String(deviceId).trim().length < 8) {
    throw new Error('Trial requires a stable device identifier.');
  }

  return issueLicense({
    tier: 'trial',
    durationMs: TRIAL_DURATION_MS,
    deviceId: String(deviceId).trim(),
    label: 'Free trial',
  });
};

export const validateLicense = (rawKey, { deviceId: incomingDeviceId } = {}) => {
  const key = String(rawKey || '').trim();

  if (!key) {
    return { ok: false, reason: 'Missing license key.' };
  }

  // Accept the new `.`-separated format (current) and the legacy `-`-separated
  // format (briefly shipped earlier). The legacy format is broken when the
  // base64url signature contains a `-`, so legacy keys mostly won't validate
  // anyway, but this keeps any that happened to work still working.
  let parts;
  if (key.startsWith(`${PREFIX}${SEP}`)) {
    parts = key.split(SEP);
  } else if (key.startsWith(`${PREFIX}-`)) {
    parts = key.split('-');
  } else {
    return { ok: false, reason: 'Invalid license format.' };
  }

  if (parts.length !== 3) {
    return { ok: false, reason: 'Invalid license format.' };
  }

  const [, payloadB64, sigB64] = parts;

  // Ed25519 signatures are 64 bytes = 86 base64url chars.
  // Legacy HMAC-SHA256 truncated sigs are 16 bytes = 22 base64url chars.
  const isEd25519 = String(sigB64).length === 86;

  if (isEd25519) {
    if (!verifyEd25519Sig(payloadB64, sigB64)) {
      return { ok: false, reason: 'License signature mismatch.' };
    }
  } else {
    const expectedSig = sign(payloadB64);
    if (!constantTimeEq(expectedSig, sigB64)) {
      return { ok: false, reason: 'License signature mismatch.' };
    }
  }

  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'License payload is corrupt.' };
  }

  // Support both old field names (t/exp/dev/lbl/iat) and new (tier/expiresAt/deviceId/label/issuedAt)
  const tier      = payload.tier  ?? payload.t   ?? 'full';
  const expiresAt = payload.expiresAt ?? payload.exp ?? 0;
  const deviceId  = payload.deviceId ?? payload.dev ?? null;
  const label     = payload.label ?? payload.lbl ?? '';
  const issuedAt  = payload.issuedAt ?? payload.iat ?? Date.now();

  if (typeof expiresAt !== 'number' || expiresAt < Date.now()) {
    return {
      ok: false,
      reason: tier === 'trial' ? 'Free trial has ended.' : 'License expired.',
      payload,
    };
  }

  if (deviceId && deviceId !== ANY_DEVICE) {
    if (!incomingDeviceId) {
      return { ok: false, reason: 'License is bound to a device. Send device id.' };
    }
    if (String(deviceId) !== String(incomingDeviceId).trim()) {
      return { ok: false, reason: 'License is bound to a different device.' };
    }
  }

  return {
    ok: true,
    license: {
      key,
      tier,
      label,
      expiresAt: new Date(expiresAt).toISOString(),
      issuedAt: new Date(issuedAt).toISOString(),
      deviceId: deviceId === ANY_DEVICE ? '' : (deviceId || ''),
    },
  };
};

export const licenseMiddleware = (request, response, next) => {
  if (request.method === 'GET' && request.path === '/health') {
    next();
    return;
  }

  if (
    request.path === '/api/license/validate' ||
    request.path === '/api/license/trial'
  ) {
    next();
    return;
  }

  const result = validateLicense(request.header('x-maalex-license'), {
    deviceId: request.header('x-maalex-device'),
  });

  if (!result.ok) {
    response.status(401).json({ error: result.reason });
    return;
  }

  request.license = result.license;
  next();
};
