import { Agent, setGlobalDispatcher } from 'undici';

// Telesom calls go over the user's network (often a slow VPN). Node's default
// 10s TCP connect timeout is too aggressive — bump everything to 30s and let
// undici reuse keep-alive connections for repeat calls.
setGlobalDispatcher(
  new Agent({
    connect: { timeout: 30_000 },
    headersTimeout: 30_000,
    bodyTimeout: 60_000,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 600_000,
  })
);

const API_BASE = 'https://mymerchant.telesom.com';
const HEADERS = {
  'Content-Type': 'application/json;charset=UTF-8',
  Accept: 'application/json; charset=utf-8',
  Origin: API_BASE,
  Referer: `${API_BASE}/`,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const USER_NATURE = 'MERCHANT';
const RESULT_OK_VALUES = new Set(['0', '2001']);
const RESULT_OTP_REQUIRED = '1001';

const isOkResult = (code) => RESULT_OK_VALUES.has(String(code ?? ''));

// Per-upstream-session cookie jars. Map<upstreamSessionId, Map<cookieName, cookieValue>>.
// Pre-login calls use the special key '__bootstrap__' and are migrated to the
// real sessionId once the server returns it.
const cookieJars = new Map();
const BOOTSTRAP_KEY = '__bootstrap__';

const parseSetCookie = (rawSetCookie) => {
  // Node fetch returns Set-Cookie as a single string with multiple cookies
  // separated by commas (commas inside Expires=... are tricky). Split on
  // ", " followed by a cookie-name=value pattern.
  if (!rawSetCookie) return [];
  const parts = rawSetCookie.split(/,(?=\s*[A-Za-z0-9!#$%&'*+\-.^_`|~]+=)/);
  const out = [];
  for (const part of parts) {
    const segs = part.split(';');
    const first = segs[0].trim();
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) out.push([name, value]);
  }
  return out;
};

const collectSetCookie = (headers) => {
  if (typeof headers?.getSetCookie === 'function') {
    const arr = headers.getSetCookie();
    return arr.flatMap(parseSetCookie);
  }
  const raw = headers?.get?.('set-cookie');
  return parseSetCookie(raw || '');
};

const getJar = (key) => {
  let jar = cookieJars.get(key);
  if (!jar) {
    jar = new Map();
    cookieJars.set(key, jar);
  }
  return jar;
};

const serializeJar = (jar) => {
  if (!jar || jar.size === 0) return '';
  const out = [];
  for (const [name, value] of jar.entries()) {
    out.push(`${name}=${value}`);
  }
  return out.join('; ');
};

export const clearTelesomCookies = (sessionKey) => {
  if (sessionKey) {
    cookieJars.delete(sessionKey);
  } else {
    cookieJars.clear();
  }
};

export const promoteBootstrapCookies = (sessionKey) => {
  const bootstrap = cookieJars.get(BOOTSTRAP_KEY);
  if (!bootstrap || bootstrap.size === 0) return;
  const target = getJar(sessionKey);
  for (const [k, v] of bootstrap.entries()) target.set(k, v);
  cookieJars.delete(BOOTSTRAP_KEY);
};

const describeFetchFailure = (error, path) => {
  const cause = error?.cause;
  const code = cause?.code || error?.code;
  const causeMessage = cause?.message ? `: ${cause.message}` : '';
  const codePart = code ? ` [${code}]` : '';

  return `Cannot reach Telesom (${path})${codePart}${causeMessage}`;
};

const post = async (path, body, { sessionKey } = {}) => {
  const jarKey = sessionKey || BOOTSTRAP_KEY;
  const jar = getJar(jarKey);
  const cookieHeader = serializeJar(jar);

  const requestHeaders = { ...HEADERS };
  if (cookieHeader) {
    requestHeaders.Cookie = cookieHeader;
  }

  const tryFetch = async () =>
    fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
    });

  const isConnectTimeout = (err) => {
    const code = err?.code || err?.cause?.code;
    return code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT';
  };

  let response;
  try {
    response = await tryFetch();
  } catch (error) {
    if (isConnectTimeout(error)) {
      console.warn(`[telesomApi] connect timeout on ${path}, retrying once…`);
      try {
        response = await tryFetch();
      } catch (retryError) {
        console.error(
          `[telesomApi] retry failed on ${path}:`,
          retryError?.cause || retryError
        );
        const wrapped = new Error(describeFetchFailure(retryError, path));
        wrapped.cause = retryError;
        throw wrapped;
      }
    } else {
      console.error(`[telesomApi] fetch failed on ${path}:`, error?.cause || error);
      const wrapped = new Error(describeFetchFailure(error, path));
      wrapped.cause = error;
      throw wrapped;
    }
  }

  // Persist any Set-Cookie headers into the jar (silent — Telesom's API
  // doesn't use cookies in normal operation, but keep the jar in case it
  // starts).
  const setCookies = collectSetCookie(response.headers);
  if (setCookies.length > 0) {
    for (const [name, value] of setCookies) {
      jar.set(name, value);
    }
  }

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Telesom returned non-JSON response (status ${response.status}).`);
  }

  if (!response.ok && !data?.resultCode) {
    throw new Error(`Telesom HTTP ${response.status} on ${path}.`);
  }

  return data || {};
};

const okOrThrow = (data, fallbackMessage) => {
  const code = String(data?.resultCode ?? '');

  if (!isOkResult(code)) {
    const message = data?.replyMessage || data?.errorDescription || fallbackMessage;
    const error = new Error(message);
    error.resultCode = code;
    throw error;
  }

  return data;
};

// Minimal body — userNature + sessionId only. Endpoints that need `type`
// (login, 2auth) add it explicitly. Adding extra keys to /balance and
// /transactions causes the merchant API to return a misleading
// "Session has expired" (resultCode 4005).
const baseBody = (sessionId) => ({
  userNature: USER_NATURE,
  ...(sessionId ? { sessionId } : {}),
});

export const customerLogin = async ({ username, userPassword, currency }) => {
  // Login has no session yet — uses the bootstrap jar; cookies will be
  // promoted to the real sessionId by the caller.
  clearTelesomCookies(BOOTSTRAP_KEY);

  const data = await post(
    '/api/account/login',
    {
      ...baseBody(),
      type: USER_NATURE,
      username,
      password: String(userPassword),
      currency: String(currency || '840'),
    },
    { sessionKey: BOOTSTRAP_KEY }
  );

  console.log(
    `[telesomApi] <- /api/account/login resultCode=${data?.resultCode} sessionIdLen=${data?.sessionId?.length || 0} replyMessage=${JSON.stringify(data?.replyMessage)}`
  );

  const code = String(data?.resultCode ?? '');

  if (code === RESULT_OTP_REQUIRED) {
    return {
      otpRequired: true,
      sessionId: data.sessionId,
      replyMessage: data.replyMessage || 'Please enter the SMS code Telesom just sent you.',
    };
  }

  if (isOkResult(code)) {
    return {
      otpRequired: false,
      sessionId: data.sessionId,
      replyMessage: data.replyMessage || 'Logged in.',
    };
  }

  const error = new Error(data?.replyMessage || data?.errorDescription || 'Telesom rejected the login credentials.');
  error.resultCode = code;
  throw error;
};

export const secondAuthentication = async ({ sessionId, secureId }) => {
  const cleanCode = String(secureId || '').replace(/\D/g, '').trim();

  // Move bootstrap cookies (set during /login) onto this session's jar.
  promoteBootstrapCookies(sessionId);

  console.log(
    `[telesomApi] -> POST /api/account/2auth sessionId=<len ${sessionId?.length || 0}> codeLength=${cleanCode.length}`
  );

  const data = await post(
    '/api/account/2auth',
    {
      ...baseBody(sessionId),
      type: USER_NATURE,
      code: cleanCode,
    },
    { sessionKey: sessionId }
  );

  console.log(
    `[telesomApi] <- /api/account/2auth resultCode=${data?.resultCode} returnedSessionIdLen=${data?.sessionId?.length || 0} sameAsRequest=${data?.sessionId === sessionId} replyMessage=${JSON.stringify(data?.replyMessage)}`
  );

  return okOrThrow(data, 'Telesom did not accept the SMS code.');
};

export const balanceQuery = async ({ sessionId }) => {
  const data = await post('/api/account/balance', baseBody(sessionId), { sessionKey: sessionId });

  // Only log on errors, not the happy path — this fires every ~750ms.
  if (!isOkResult(data?.resultCode)) {
    console.warn(
      `[telesomApi] balance non-OK resultCode=${data?.resultCode} replyMessage=${JSON.stringify(data?.replyMessage)}`
    );
  }

  return okOrThrow(data, 'Could not read balance.');
};

export const showMiniStatement = async ({ sessionId }) => {
  const data = await post('/api/account/transactions', baseBody(sessionId), { sessionKey: sessionId });
  return okOrThrow(data, 'Could not load recent transactions.');
};

export const getReceiverInfo = async ({ sessionId, receiverMobile }) => {
  const data = await post(
    '/api/account/find',
    {
      ...baseBody(sessionId),
      type: 'internetwork',
      mobileNo: receiverMobile,
    },
    { sessionKey: sessionId }
  );

  return okOrThrow(data, 'Could not look up receiver name.');
};

export const p2pTransfer = async ({
  sessionId,
  receiverMobile,
  amount,
  receiverName,
  pin,
  description,
  isInterNetwork,
}) => {
  const data = await post(
    '/api/money/b2p',
    {
      ...baseBody(sessionId),
      receiverMobile,
      receiverName,
      pin: String(pin),
      amount: String(amount),
      description: String(description || ''),
      isInterNetwork: String(isInterNetwork ?? '0'),
    },
    { sessionKey: sessionId }
  );

  return okOrThrow(data, 'Telesom did not confirm the transfer.');
};
