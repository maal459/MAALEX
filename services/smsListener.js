// Android SMS listener — parallel detection signal alongside the WebView
// activity-report poll loop. Whichever path observes a credit first wins;
// the auto-transfer pipeline is idempotent (guarded by `isRunning`) so a
// double-detect is never a double-spend. iOS gracefully no-ops.

import { Platform, PermissionsAndroid } from 'react-native';

let SmsListener = null;
try {
  if (Platform.OS === 'android') {
    // eslint-disable-next-line global-require
    SmsListener = require('react-native-android-sms-listener').default;
  }
} catch {
  SmsListener = null;
}

const TRUSTED_SENDER_PATTERN = /(zaad|telesom|mymerchant|^4(56|60|70)$|^611$)/i;
const CREDIT_INDICATOR = /(received|heshay|credited|incoming|ka\s*hel(ay)?|waad\s*hel(ay)?|deposited)/i;
const AMOUNT_PATTERN = /(?:USD|US\$|\$)\s*([\d.,]+)|(\d+(?:[.,]\d{1,2})?)\s*(?:USD|US\$|\$)/i;

const sanitizeAmount = (raw) => {
  if (!raw) return NaN;
  let s = String(raw).trim().replace(/^[.,]+|[.,]+$/g, '');
  if (!s) return NaN;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasComma && !hasDot) s = s.replace(/,/g, '.');
  else if (hasComma && hasDot) s = s.replace(/,/g, '');
  const lastDot = s.lastIndexOf('.');
  if (lastDot >= 0) s = s.slice(0, lastDot).replace(/\./g, '') + s.slice(lastDot);
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
};

export const parseTelesomPaymentSms = (sms) => {
  if (!sms || typeof sms !== 'object') return null;
  const body = String(sms.body || sms.message || '').trim();
  const sender = String(sms.originatingAddress || sms.address || '').trim();
  if (!body) return null;

  if (sender && !TRUSTED_SENDER_PATTERN.test(sender)) {
    if (!/zaad|telesom|mymerchant/i.test(body)) return null;
  }
  if (!CREDIT_INDICATOR.test(body)) return null;

  const m = body.match(AMOUNT_PATTERN);
  if (!m) return null;

  const amount = sanitizeAmount(m[1] || m[2]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return { amount, body, sender, receivedAt: new Date().toISOString() };
};

export const ensureSmsPermission = async () => {
  if (Platform.OS !== 'android') return false;
  try {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
      {
        title: 'SMS payment notifications',
        message:
          'MAALEX uses payment SMS to forward funds the moment Telesom notifies you — no balance polling delay.',
        buttonPositive: 'Allow',
        buttonNegative: 'Not now',
      }
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
};

export const isSmsSupported = () => Platform.OS === 'android' && Boolean(SmsListener);

export const subscribeToCreditSms = (onCredit) => {
  if (!isSmsSupported()) return () => {};
  let subscription;
  try {
    subscription = SmsListener.addListener((message) => {
      const parsed = parseTelesomPaymentSms(message);
      if (parsed) {
        try {
          onCredit(parsed);
        } catch {
          // Swallow handler errors so one bad listener can't kill the bridge.
        }
      }
    });
  } catch {
    return () => {};
  }
  return () => {
    try {
      subscription?.remove?.();
    } catch {
      // ignore
    }
  };
};
