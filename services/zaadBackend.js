import AsyncStorage from '@react-native-async-storage/async-storage';
import { ZAAD_BACKEND_BASE_URL, isZaadBackendConfigured } from '../constants/zaadBackendConfig';
import { getCachedDeviceId, getDeviceId } from './deviceId';

export const LICENSE_STORAGE_KEY = '@maalex/license-key';

export class ZaadBackendError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ZaadBackendError';
    this.status = status;
    this.data = data;
  }
}

let cachedLicenseKey = '';

export const setCachedLicenseKey = (key) => {
  cachedLicenseKey = String(key || '').trim();
};

export const getCachedLicenseKey = () => cachedLicenseKey;

export const loadStoredLicenseKey = async () => {
  try {
    const stored = await AsyncStorage.getItem(LICENSE_STORAGE_KEY);
    if (stored) {
      cachedLicenseKey = stored;
    }
    return stored || '';
  } catch {
    return '';
  }
};

export const persistLicenseKey = async (key) => {
  setCachedLicenseKey(key);

  try {
    await AsyncStorage.setItem(LICENSE_STORAGE_KEY, String(key || '').trim());
  } catch {
    // Ignore — in-memory cache still works for the session.
  }
};

export const clearLicenseKey = async () => {
  cachedLicenseKey = '';

  try {
    await AsyncStorage.removeItem(LICENSE_STORAGE_KEY);
  } catch {
    // Ignore.
  }
};

const DEFAULT_TIMEOUT_MS = 12_000;

const request = async (path, options = {}) => {
  if (!isZaadBackendConfigured()) {
    throw new ZaadBackendError(
      'Set EXPO_PUBLIC_ZAAD_BACKEND_URL to the address of your MAALEX backend.',
      0,
      null
    );
  }

  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (cachedLicenseKey) {
    headers['x-maalex-license'] = cachedLicenseKey;
  }

  // Device ID is required by trial-bound licenses on the server side.
  const deviceId = getCachedDeviceId() || (await getDeviceId());
  if (deviceId) {
    headers['x-maalex-device'] = deviceId;
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${ZAAD_BACKEND_BASE_URL}${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new ZaadBackendError(
        `MAALEX backend did not respond within ${timeoutMs}ms — check connectivity to ${ZAAD_BACKEND_BASE_URL}.`,
        0,
        null
      );
    }
    throw new ZaadBackendError(
      err?.message || 'Network error talking to MAALEX backend.',
      0,
      null
    );
  } finally {
    clearTimeout(timer);
  }

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    throw new ZaadBackendError(
      data?.error || data?.message || `Request failed with status ${response.status}.`,
      response.status,
      data
    );
  }

  return data;
};

export const validateLicenseRemote = async (licenseKey) => {
  const deviceId = await getDeviceId();
  const data = await request('/api/license/validate', {
    method: 'POST',
    body: { licenseKey, deviceId },
  });

  return data.license;
};

export const requestTrialLicense = async () => {
  const deviceId = await getDeviceId();
  const data = await request('/api/license/trial', {
    method: 'POST',
    body: { deviceId },
  });

  return data.license;
};

export const loginToZaad = async ({
  loginIdentifier,
  loginPassword,
  currency,
  autoTransfer,
}) => {
  const data = await request('/api/zaad/session/login', {
    method: 'POST',
    body: { loginIdentifier, loginPassword, currency, autoTransfer },
  });

  return data.session;
};

export const submitZaadAuthenticationCode = async ({
  sessionId,
  authenticationCode,
  autoTransfer,
}) => {
  const data = await request('/api/zaad/session/otp', {
    method: 'POST',
    body: { sessionId, authenticationCode, autoTransfer },
  });

  return data.session;
};

export const getZaadSession = async (sessionId) => {
  const data = await request(`/api/zaad/session/${encodeURIComponent(sessionId)}`);
  return data.session;
};

export const refreshZaadBalance = async (sessionId, autoTransfer) => {
  const data = await request(`/api/zaad/session/${encodeURIComponent(sessionId)}/balance`, {
    method: 'POST',
    body: autoTransfer ? { autoTransfer } : undefined,
  });

  return data.session;
};

export const transferZaadFunds = async ({
  sessionId,
  recipientNumber,
  amountUsd,
  description,
  sourceAccountLabel,
  transactionPin,
  confirmTransfer = true,
}) => {
  const data = await request(`/api/zaad/session/${encodeURIComponent(sessionId)}/transfer`, {
    method: 'POST',
    body: {
      recipientNumber,
      amountUsd,
      description,
      sourceAccountLabel,
      transactionPin,
      confirmTransfer,
    },
  });

  return data.session;
};

export const fetchZaadTransactions = async (sessionId) => {
  const data = await request(`/api/zaad/session/${encodeURIComponent(sessionId)}/transactions`);
  return data.transactions || [];
};

export const closeZaadSession = async (sessionId) => {
  await request(`/api/zaad/session/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
};
