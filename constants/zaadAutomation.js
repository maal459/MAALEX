export const ZAAD_MIN_BALANCE_USD = 1;

export const ZAAD_BALANCE_CHECK_USSD = '*882#';

export const ZAAD_SEND_USSD_TEMPLATE = '*880*{recipient}*{amount}#';

export const ZAAD_SEND_TEMPLATE_EXAMPLE = '*XXX*{recipient}*{amount}#';

export const ZAAD_SMS_ALLOWED_SENDERS = [];

export const ZAAD_SMS_BALANCE_PATTERNS = [
  /\b(?:balance|haraag(?:a)?|hadhaag(?:a)?|haraad)\b[\s\S]{0,48}?(\d+(?:[.,]\d{1,2})?)\s*(?:usd|dollar|\$)?/i,
  /\b(?:your|zaad|account)\b[\s\S]{0,48}?\b(?:balance|haraag(?:a)?)\b[\s\S]{0,48}?(\d+(?:[.,]\d{1,2})?)/i,
];

export const ZAAD_AUTOMATION_HELP_TEXT =
  'Android-only SMS monitoring requires a development build. Keep this screen open, run *882#, and the assistant will update the local balance estimate when a matching ZAAD SMS arrives.';

const sanitizePhoneNumber = (value) => value.replace(/\s+/g, '');

const normalizeNumericCapture = (value) => {
  const trimmed = value.trim();

  if (trimmed.includes(',') && !trimmed.includes('.')) {
    return trimmed.replace(',', '.');
  }

  return trimmed.replace(/,/g, '');
};

export function extractZaadBalanceFromSms({ originatingAddress = '', body = '' }) {
  const normalizedSender = originatingAddress.toLowerCase();
  const normalizedBody = body.trim();

  if (!normalizedBody) {
    return null;
  }

  if (
    ZAAD_SMS_ALLOWED_SENDERS.length > 0 &&
    !ZAAD_SMS_ALLOWED_SENDERS.some((sender) => normalizedSender.includes(sender.toLowerCase()))
  ) {
    return null;
  }

  for (const pattern of ZAAD_SMS_BALANCE_PATTERNS) {
    const match = normalizedBody.match(pattern);

    if (!match?.[1]) {
      continue;
    }

    const amount = Number.parseFloat(normalizeNumericCapture(match[1]));

    if (Number.isFinite(amount)) {
      return amount;
    }
  }

  return null;
}

export function formatBalanceEstimate(value) {
  if (!Number.isFinite(value)) {
    return 'Not detected yet';
  }

  return `$${value.toFixed(2)}`;
}

export function buildZaadSendUssd({ recipientNumber, amountUsd }) {
  if (!recipientNumber || !amountUsd) {
    return '';
  }

  if (!ZAAD_SEND_USSD_TEMPLATE) {
    return '';
  }

  return ZAAD_SEND_USSD_TEMPLATE
    .replace('{recipient}', sanitizePhoneNumber(recipientNumber))
    .replace('{amount}', amountUsd.trim());
}