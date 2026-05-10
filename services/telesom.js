// Thin client over the Telesom MyMerchant JSON API. Every call is dispatched
// through the hidden WebView bridge so requests originate from the user's
// phone (Somali IP, real browser fingerprint).
//
// Mirrors what server/src/telesomApi.js used to do, but on-device.

import { callTelesom } from './telesomBridge';

const USER_NATURE = 'MERCHANT';
const RESULT_OK = new Set(['0', '2001']);
const RESULT_OTP_REQUIRED = '1001';

const isOk = (code) => RESULT_OK.has(String(code ?? ''));

const post = async (path, body) => {
  const { body: data } = await callTelesom(path, body);
  return data || {};
};

const okOrThrow = (data, fallback) => {
  if (!isOk(data?.resultCode)) {
    const err = new Error(data?.replyMessage || data?.errorDescription || fallback);
    err.resultCode = String(data?.resultCode ?? '');
    throw err;
  }
  return data;
};

export const customerLogin = async ({ username, password, currency }) => {
  const data = await post('/api/account/login', {
    userNature: USER_NATURE,
    type: USER_NATURE,
    username,
    password: String(password),
    currency: String(currency || '840'),
  });

  const code = String(data?.resultCode ?? '');

  if (code === RESULT_OTP_REQUIRED) {
    return {
      otpRequired: true,
      sessionId: data.sessionId,
      replyMessage: data.replyMessage || 'Please enter the SMS code Telesom just sent you.',
    };
  }

  if (isOk(code)) {
    return {
      otpRequired: false,
      sessionId: data.sessionId,
      replyMessage: data.replyMessage || 'Logged in.',
    };
  }

  const err = new Error(
    data?.replyMessage || data?.errorDescription || 'Telesom rejected the login credentials.'
  );
  err.resultCode = code;
  throw err;
};

export const secondAuthentication = async ({ sessionId, code }) => {
  const data = await post('/api/account/2auth', {
    userNature: USER_NATURE,
    sessionId,
    type: USER_NATURE,
    code: String(code || '').replace(/\D/g, ''),
  });

  return okOrThrow(data, 'Telesom did not accept the SMS code.');
};

export const balanceQuery = async ({ sessionId }) => {
  const data = await post('/api/account/balance', {
    userNature: USER_NATURE,
    sessionId,
  });
  return okOrThrow(data, 'Could not read balance.');
};

export const showMiniStatement = async ({ sessionId }) => {
  const data = await post('/api/account/transactions', {
    userNature: USER_NATURE,
    sessionId,
  });
  return okOrThrow(data, 'Could not load recent transactions.');
};

export const activityReport = async ({ sessionId, startDate, endDate }) => {
  const data = await post('/api/report/activity', {
    userNature: USER_NATURE,
    sessionId,
    startDate,
    endDate,
  });
  return okOrThrow(data, 'Could not load activity report.');
};

// Telesom's /api/account/find requires a `type` discriminator that matches
// the network the recipient belongs to. The set of valid values isn't
// documented publicly — we try the most likely candidates in order and use
// the first OK response. Each failed attempt is logged with Telesom's own
// reply text so future debugging doesn't have to guess what the codes mean.
//
// Known so far (from production logs):
//   resultCode 7003 = not in cross-carrier directory ('internetwork')
//   resultCode 5003 = ??? (returned for 'zaad' on a same-network number)
const RECEIVER_LOOKUP_TYPES = ['zaad', 'merchant', 'internetwork', 'normal'];

export const getReceiverInfo = async ({ sessionId, receiverMobile }) => {
  const failures = [];
  let lastData = null;

  for (const type of RECEIVER_LOOKUP_TYPES) {
    const data = await post('/api/account/find', {
      userNature: USER_NATURE,
      sessionId,
      type,
      mobileNo: receiverMobile,
    });

    if (isOk(data?.resultCode)) {
      if (failures.length > 0) {
        console.log(
          `[telesom.find] succeeded with type='${type}' after ${failures.length} attempt(s) failed: ${failures.join('; ')}`
        );
      }
      return data;
    }

    const code = String(data?.resultCode ?? '');
    const reply = data?.replyMessage || data?.errorDescription || '';
    failures.push(`type='${type}' code=${code}${reply ? ` msg=${JSON.stringify(reply)}` : ''}`);
    lastData = data;
  }

  console.warn(
    `[telesom.find] all ${RECEIVER_LOOKUP_TYPES.length} candidate type(s) failed for ${receiverMobile}: ${failures.join(' | ')}`
  );

  return okOrThrow(lastData, 'Could not look up receiver name.');
};

export const p2pTransfer = async ({
  sessionId,
  receiverMobile,
  receiverName,
  amount,
  pin,
  description,
  isInterNetwork,
}) => {
  const data = await post('/api/money/b2p', {
    userNature: USER_NATURE,
    sessionId,
    receiverMobile,
    receiverName,
    pin: String(pin),
    amount: String(amount),
    description: String(description || ''),
    isInterNetwork: String(isInterNetwork ?? '0'),
  });
  return okOrThrow(data, 'Telesom did not confirm the transfer.');
};
