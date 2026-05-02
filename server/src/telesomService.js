import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import {
  balanceQuery,
  clearTelesomCookies,
  customerLogin,
  getReceiverInfo,
  p2pTransfer,
  secondAuthentication,
  showMiniStatement,
} from './telesomApi.js';

const AUTO_TRANSFER_DEFAULT_TRIGGER_BALANCE_USD = '600';
const AUTO_TRANSFER_MINIMUM_TRIGGER_USD = 0;
const AUTO_TRANSFER_MONITOR_INTERVAL_MS = 750;
const AUTO_TRANSFER_RATE_LIMIT_BACKOFF_MS = 8000;
const NETWORK_FAILURE_BACKOFF_MS = 30_000;
const RECENT_EVENTS_LIMIT = 20;
const RATE_LIMIT_PATTERN = /too\s*many\s*requests|rate\s*limit|throttle/i;
const NETWORK_FAILURE_PATTERN = /Cannot reach Telesom|connect timeout|ETIMEDOUT|ECONNRESET|ENETUNREACH|ENOTFOUND/i;

const LOGIN_ROUTE = '#/login';
const SECOND_AUTH_ROUTE = '#/second-authentication';
const DASHBOARD_ROUTE = '#/dashboard';

const DEFAULT_CURRENCY = '840';

const sanitizePhoneNumber = (value) => String(value ?? '').replace(/\s+/g, '').trim();
const normalizeAmount = (value) => String(value ?? '').replace(/,/g, '').trim();
const parseAmountNumber = (value) => Number.parseFloat(normalizeAmount(value));
const formatAmountForTransfer = (value) => {
  if (!Number.isFinite(value)) {
    return '';
  }

  return Number.isInteger(value) ? String(value) : value.toFixed(2);
};

const sanitizePin = (value) => String(value ?? '').replace(/\D/g, '').trim();

const toLocalReceiverFormat = (raw) => {
  let value = sanitizePhoneNumber(raw).replace(/^\+/, '');

  if (value.startsWith('252')) {
    value = value.slice(3);
  }

  if (!value.startsWith('0')) {
    value = `0${value}`;
  }

  return value;
};

const toUsernameFormat = (raw) => {
  let value = sanitizePhoneNumber(raw).replace(/^\+/, '');

  if (value.startsWith('0')) {
    value = `252${value.slice(1)}`;
  } else if (!value.startsWith('252')) {
    value = `252${value}`;
  }

  return value;
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const wrapApiError = (error, fallbackStatus = 502) => {
  if (error instanceof HttpError) {
    return error;
  }

  return new HttpError(fallbackStatus, error.message || 'Telesom request failed.');
};

const normalizeAutoTransferSettings = (payload = {}, currentSettings = {}) => {
  const recipientNumber = sanitizePhoneNumber(
    payload?.recipientNumber ?? currentSettings.recipientNumber ?? ''
  );
  const amountUsd = normalizeAmount(payload?.amountUsd ?? currentSettings.amountUsd ?? '');
  const triggerBalanceUsd = normalizeAmount(
    payload?.triggerBalanceUsd ??
      currentSettings.triggerBalanceUsd ??
      AUTO_TRANSFER_DEFAULT_TRIGGER_BALANCE_USD
  );
  const description = String(payload?.description ?? currentSettings.description ?? '').trim();
  const pin = sanitizePin(payload?.pin ?? currentSettings.pin ?? '');
  const amountValue = parseAmountNumber(amountUsd);
  const triggerBalanceValue = parseAmountNumber(triggerBalanceUsd);

  return {
    recipientNumber,
    amountUsd,
    triggerBalanceUsd,
    description,
    pin,
    enabled:
      recipientNumber.length > 0 &&
      pin.length >= 4 &&
      Number.isFinite(triggerBalanceValue) &&
      triggerBalanceValue >= AUTO_TRANSFER_MINIMUM_TRIGGER_USD &&
      (!amountUsd || (Number.isFinite(amountValue) && amountValue > 0)),
  };
};

const pickUsdAccount = (accountInformation) => {
  if (!Array.isArray(accountInformation) || accountInformation.length === 0) {
    return null;
  }

  return (
    accountInformation.find(
      (account) => String(account.currencyName).toUpperCase() === 'USD'
    ) ||
    accountInformation.find((account) => account.isDefaultAccount) ||
    accountInformation[0]
  );
};

const serializeSession = (session) => {
  let status = 'pending';
  let route = LOGIN_ROUTE;

  if (!session.telesomSessionId) {
    status = session.requiresAuthenticationCode ? 'otp_required' : 'signed_out';
    route = LOGIN_ROUTE;
  } else if (session.requiresAuthenticationCode) {
    status = 'otp_required';
    route = SECOND_AUTH_ROUTE;
  } else if (session.balanceUsd) {
    status = 'connected';
    route = DASHBOARD_ROUTE;
  } else if (session.accountInformation?.length) {
    status = 'loading_balance';
    route = DASHBOARD_ROUTE;
  } else {
    status = 'verifying_otp';
    route = SECOND_AUTH_ROUTE;
  }

  return {
    sessionId: session.id,
    status,
    requiresAuthenticationCode: session.requiresAuthenticationCode,
    route,
    accountLabel: session.accountLabel || '',
    accountHolderName: session.accountHolderName || '',
    balanceUsd: session.balanceUsd || '',
    receiverName: session.receiverName || '',
    lastUpdatedAt: session.updatedAt,
    lastMessage: session.lastMessage || '',
    recentEvents: Array.isArray(session.recentEvents) ? session.recentEvents.slice(-RECENT_EVENTS_LIMIT) : [],
    autoTransfer: {
      recipientNumber: session.autoTransfer?.recipientNumber || '',
      amountUsd: session.autoTransfer?.amountUsd || '',
      triggerBalanceUsd:
        session.autoTransfer?.triggerBalanceUsd || AUTO_TRANSFER_DEFAULT_TRIGGER_BALANCE_USD,
      enabled: Boolean(session.autoTransfer?.enabled),
      armed: Boolean(session.autoTransfer?.armed),
      lastTriggeredAt: session.autoTransfer?.lastTriggeredAt || '',
      lastError: session.autoTransfer?.lastError || '',
      pinConfigured: Boolean(session.autoTransfer?.pin),
    },
  };
};

const recordEvent = (session, type, message, extra = {}) => {
  if (!Array.isArray(session.recentEvents)) {
    session.recentEvents = [];
  }

  session.recentEvents.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    message,
    at: new Date().toISOString(),
    ...extra,
  });

  if (session.recentEvents.length > RECENT_EVENTS_LIMIT) {
    session.recentEvents = session.recentEvents.slice(-RECENT_EVENTS_LIMIT);
  }
};

export class TelesomAutomationService {
  constructor() {
    this.sessions = new Map();
    const interval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 60_000);

    interval.unref?.();
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new HttpError(404, 'The backend session was not found. Sign in again.');
    }

    if (Date.now() - session.lastTouchedAt > config.sessionTtlMs) {
      this.destroySession(sessionId);
      throw new HttpError(404, 'The backend session expired. Sign in again.');
    }

    session.lastTouchedAt = Date.now();
    return session;
  }

  cleanupExpiredSessions() {
    const now = Date.now();

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastTouchedAt > config.sessionTtlMs) {
        this.stopSessionAutoMonitor(session);
        this.sessions.delete(sessionId);
      }
    }
  }

  async createSession({ loginIdentifier, loginPassword, currency, autoTransfer }) {
    const username = toUsernameFormat(loginIdentifier);

    if (!username || username === '252') {
      throw new HttpError(400, 'Login identifier is required.');
    }

    if (!String(loginPassword || '').trim()) {
      throw new HttpError(400, 'Login password is required.');
    }

    const session = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastTouchedAt: Date.now(),
      username,
      currency: String(currency || DEFAULT_CURRENCY),
      telesomSessionId: '',
      secureId: '',
      subscriptionId: '',
      partnerId: '',
      partnerUID: '',
      accountInformation: [],
      account: null,
      accountHolderName: '',
      rawServiceInformation: [],
      recentEvents: [],
      rateLimitedUntil: 0,
      requiresAuthenticationCode: false,
      accountLabel: '',
      balanceUsd: '',
      receiverName: '',
      lastMessage: '',
      autoTransfer: {
        ...normalizeAutoTransferSettings(autoTransfer),
        armed: true,
        isRunning: false,
        lastTriggeredAt: '',
        lastError: '',
      },
      monitorTimer: null,
    };

    this.sessions.set(session.id, session);
    this.reconcileSessionAutoMonitor(session);

    try {
      const loginResult = await customerLogin({
        username,
        userPassword: String(loginPassword),
        currency: session.currency,
      });

      session.telesomSessionId = loginResult.sessionId;
      session.updatedAt = new Date().toISOString();

      if (loginResult.otpRequired) {
        session.requiresAuthenticationCode = true;
        session.lastMessage = loginResult.replyMessage;
        return serializeSession(session);
      }

      session.requiresAuthenticationCode = false;
      session.lastMessage = loginResult.replyMessage;
      return serializeSession(session);
    } catch (error) {
      this.destroySession(session.id);
      throw wrapApiError(error, 502);
    }
  }

  async submitAuthenticationCode(sessionId, authenticationCode, autoTransfer) {
    const code = String(authenticationCode || '').trim();

    if (!code) {
      throw new HttpError(400, 'Authentication code is required.');
    }

    const session = this.getSession(sessionId);

    if (!session.telesomSessionId) {
      throw new HttpError(409, 'Sign in again — the Telesom session is missing.');
    }

    this.updateSessionAutoTransfer(session, autoTransfer);

    try {
      const profile = await secondAuthentication({
        sessionId: session.telesomSessionId,
        secureId: code,
      });

      if (profile?.sessionId && profile.sessionId !== session.telesomSessionId) {
        console.log(
          `[telesomService] sessionId rotated by /2auth (oldLen=${session.telesomSessionId.length}, newLen=${profile.sessionId.length}) — using new id`
        );
        session.telesomSessionId = profile.sessionId;
      }

      session.secureId = code;
      session.subscriptionId = profile.subscriptionId || session.subscriptionId;
      session.partnerId = profile.partnerId || '';
      session.partnerUID = profile.partnerUID || '';
      session.accountHolderName = String(profile.name || '').trim();
      session.accountInformation = profile.accountInformation || [];
      session.rawServiceInformation = profile.serviceInformation || [];
      session.account = pickUsdAccount(session.accountInformation);

      if (!session.account) {
        throw new HttpError(502, 'Telesom did not return any accounts for this user.');
      }

      session.accountLabel = session.account.accountTitle || '';
      session.requiresAuthenticationCode = false;
      session.lastMessage = 'Authentication accepted.';
      session.updatedAt = new Date().toISOString();

      await this.refreshAccountData(session);
      return serializeSession(session);
    } catch (error) {
      session.lastMessage = error.message;
      session.updatedAt = new Date().toISOString();
      throw wrapApiError(error, 400);
    }
  }

  getSessionSnapshot(sessionId) {
    const session = this.getSession(sessionId);
    return serializeSession(session);
  }

  async refreshBalance(sessionId, payload = {}) {
    const session = this.getSession(sessionId);
    this.updateSessionAutoTransfer(session, payload?.autoTransfer);

    if (session.requiresAuthenticationCode) {
      return serializeSession(session);
    }

    if (!session.account) {
      throw new HttpError(409, 'Finish authentication before refreshing balance.');
    }

    await this.refreshAccountData(session);
    return serializeSession(session);
  }

  async transfer(sessionId, payload) {
    const session = this.getSession(sessionId);
    await this.performTransfer(session, payload);
    return serializeSession(session);
  }

  async getRecentTransactions(sessionId) {
    const session = this.getSession(sessionId);

    if (session.requiresAuthenticationCode || !session.account) {
      throw new HttpError(409, 'Finish authentication before loading transactions.');
    }

    try {
      const result = await showMiniStatement({
        sessionId: session.telesomSessionId,
      });

      const rows = Array.isArray(result?.transactionInfo) ? result.transactionInfo : [];

      return rows.map((row, index) => ({
        id: String(row?.['Transaction-Id'] || row?.['Transfer-Id'] || `${index}-${row?.['Transaction-Date'] || ''}`),
        amount: String(row?.['Tx-Amount'] ?? row?.['TxAmount'] ?? row?.amount ?? ''),
        direction: String(row?.['Tx-Type'] || row?.['Transaction-Type'] || row?.direction || '').toLowerCase(),
        counterparty: String(row?.['Other-Party'] || row?.['Counterparty'] || row?.['Receiver-Name'] || row?.['Sender-Name'] || ''),
        date: String(row?.['Transaction-Date'] || row?.['Tx-Date'] || row?.date || ''),
        description: String(row?.description || row?.['Description'] || row?.['Reply-Message'] || ''),
        balanceAfter: String(row?.['Current-Balance'] || row?.currentBalance || ''),
        raw: row,
      }));
    } catch (error) {
      throw wrapApiError(error, 502);
    }
  }

  destroySession(sessionId) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return;
    }

    if (session.telesomSessionId) {
      clearTelesomCookies(session.telesomSessionId);
    }

    this.sessions.delete(sessionId);
    this.stopSessionAutoMonitor(session);
  }

  async shutdown() {
    for (const session of this.sessions.values()) {
      this.stopSessionAutoMonitor(session);
    }

    this.sessions.clear();
  }

  stopSessionAutoMonitor(session) {
    if (session?.monitorTimer) {
      clearInterval(session.monitorTimer);
      session.monitorTimer = null;
    }
  }

  reconcileSessionAutoMonitor(session) {
    const shouldMonitor = Boolean(session?.autoTransfer?.enabled);

    if (!shouldMonitor) {
      this.stopSessionAutoMonitor(session);
      return;
    }

    if (session.monitorTimer) {
      return;
    }

    session.monitorTimer = setInterval(() => {
      this.tickSessionAutoMonitor(session.id).catch(() => {});
    }, AUTO_TRANSFER_MONITOR_INTERVAL_MS);
    session.monitorTimer.unref?.();
  }

  async tickSessionAutoMonitor(sessionId) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return;
    }

    if (session.autoTransfer?.isRunning) {
      return;
    }

    if (session.requiresAuthenticationCode || !session.account) {
      return;
    }

    if (session.rateLimitedUntil && Date.now() < session.rateLimitedUntil) {
      return;
    }

    session.lastTouchedAt = Date.now();

    try {
      await this.refreshAccountData(session);
    } catch (error) {
      session.lastMessage = error.message;
      session.updatedAt = new Date().toISOString();

      const msg = error.message || '';

      if (RATE_LIMIT_PATTERN.test(msg)) {
        session.rateLimitedUntil = Date.now() + AUTO_TRANSFER_RATE_LIMIT_BACKOFF_MS;
        recordEvent(
          session,
          'rate_limited',
          `Telesom rate limited us — pausing for ${Math.round(AUTO_TRANSFER_RATE_LIMIT_BACKOFF_MS / 1000)}s.`
        );
      } else if (NETWORK_FAILURE_PATTERN.test(msg)) {
        // Network is broken (no route to Telesom). Pause the monitor so we
        // stop spamming the logs and burning CPU.
        session.rateLimitedUntil = Date.now() + NETWORK_FAILURE_BACKOFF_MS;
        recordEvent(
          session,
          'rate_limited',
          `Network unreachable — pausing for ${Math.round(NETWORK_FAILURE_BACKOFF_MS / 1000)}s.`
        );
      }
    }
  }

  updateSessionAutoTransfer(session, payload) {
    if (!payload) {
      return;
    }

    const previousSettings = session.autoTransfer || {
      armed: true,
      isRunning: false,
      lastTriggeredAt: '',
      lastError: '',
    };
    const nextSettings = normalizeAutoTransferSettings(payload, previousSettings);
    const didSettingsChange =
      previousSettings.recipientNumber !== nextSettings.recipientNumber ||
      previousSettings.amountUsd !== nextSettings.amountUsd ||
      previousSettings.triggerBalanceUsd !== nextSettings.triggerBalanceUsd ||
      previousSettings.description !== nextSettings.description ||
      previousSettings.pin !== nextSettings.pin;

    session.autoTransfer = {
      ...previousSettings,
      ...nextSettings,
      armed: didSettingsChange ? true : previousSettings.armed ?? true,
      isRunning: previousSettings.isRunning ?? false,
      lastTriggeredAt: didSettingsChange ? '' : previousSettings.lastTriggeredAt || '',
      lastError: didSettingsChange ? '' : previousSettings.lastError || '',
    };

    this.reconcileSessionAutoMonitor(session);
  }

  async refreshAccountData(session) {
    try {
      const result = await balanceQuery({
        sessionId: session.telesomSessionId,
      });

      const targetAccountId = String(session.account?.accountId ?? '');

      const pickBalanceFromRow = (row) =>
        row?.currentBalance ??
        row?.['Current-Balance'] ??
        row?.['CurrentBalance'] ??
        row?.balance ??
        row?.availableBalance;

      const matchAccount = (rows, accountIdStr) =>
        Array.isArray(rows)
          ? rows.find(
              (entry) =>
                String(
                  entry?.accountId ?? entry?.['Account-Id'] ?? entry?.AccountId ?? ''
                ) === accountIdStr
            )
          : undefined;

      const fallbackRow =
        matchAccount(result?.accounts, targetAccountId) ||
        matchAccount(result?.accountList, targetAccountId) ||
        (Array.isArray(result?.accounts) ? result.accounts[0] : undefined);

      const balanceString =
        normalizeAmount(pickBalanceFromRow(result)) ||
        normalizeAmount(pickBalanceFromRow(fallbackRow));

      if (!balanceString) {
        console.warn(
          '[telesomService] balance response did not yield a numeric currentBalance — keys:',
          result ? Object.keys(result) : 'null',
          'accounts[0] keys:',
          Array.isArray(result?.accounts) && result.accounts[0]
            ? Object.keys(result.accounts[0])
            : 'n/a'
        );
      }

      const previousBalance = session.balanceUsd;

      session.balanceUsd = balanceString || session.balanceUsd;
      session.accountLabel = result.accountTitle || session.accountLabel;
      session.lastMessage = 'Balance refreshed.';
      session.updatedAt = new Date().toISOString();

      if (previousBalance && balanceString && previousBalance !== balanceString) {
        const delta =
          parseAmountNumber(balanceString) - parseAmountNumber(previousBalance);

        if (Number.isFinite(delta) && delta > 0) {
          recordEvent(session, 'balance_increase', `Received $${formatAmountForTransfer(delta)} (balance now $${balanceString}).`, {
            balance: balanceString,
            delta: formatAmountForTransfer(delta),
          });
        }
      }
    } catch (error) {
      throw wrapApiError(error, 502);
    }

    await this.maybeTriggerAutoTransfer(session);
  }

  async maybeTriggerAutoTransfer(session) {
    const settings = session.autoTransfer;

    if (!settings?.enabled || settings.isRunning || session.requiresAuthenticationCode) {
      return false;
    }

    if (!settings.pin) {
      return false;
    }

    const detectedBalance = parseAmountNumber(session.balanceUsd);
    const triggerBalance = parseAmountNumber(settings.triggerBalanceUsd);
    const requestedTransferAmount = parseAmountNumber(settings.amountUsd);
    const effectiveTransferAmount =
      Number.isFinite(requestedTransferAmount) && requestedTransferAmount > 0
        ? Math.min(requestedTransferAmount, detectedBalance)
        : detectedBalance - triggerBalance;

    if (
      !Number.isFinite(detectedBalance) ||
      !Number.isFinite(triggerBalance) ||
      !Number.isFinite(effectiveTransferAmount)
    ) {
      return false;
    }

    if (detectedBalance <= triggerBalance) {
      settings.armed = true;
      settings.lastError = '';
      return false;
    }

    if (!settings.armed) {
      return false;
    }

    if (effectiveTransferAmount <= 0) {
      return false;
    }

    settings.isRunning = true;
    settings.armed = false;
    settings.lastError = '';

    try {
      const amountToTransfer = formatAmountForTransfer(effectiveTransferAmount);

      await this.performTransfer(session, {
        recipientNumber: settings.recipientNumber,
        amountUsd: amountToTransfer,
        description: settings.description || 'MAALEX automatic transfer',
        transactionPin: settings.pin,
        confirmTransfer: true,
      });

      settings.lastTriggeredAt = new Date().toISOString();
      session.lastMessage = `Automatic transfer of $${amountToTransfer} sent to ${settings.recipientNumber}.`;
      recordEvent(session, 'auto_transfer', `Sent $${amountToTransfer} to ${settings.recipientNumber}.`, {
        amount: amountToTransfer,
        recipient: settings.recipientNumber,
      });
      settings.isRunning = false;

      try {
        await this.refreshAccountData(session);
      } catch {
        // Next monitor tick will retry — not fatal.
      }

      return true;
    } catch (error) {
      settings.armed = true;
      settings.lastError = error.message;
      session.lastMessage = error.message;
      return false;
    } finally {
      settings.isRunning = false;
    }
  }

  async performTransfer(session, payload) {
    if (session.requiresAuthenticationCode) {
      throw new HttpError(409, 'Finish the MyMerchant authentication step before sending funds.');
    }

    if (!session.account) {
      throw new HttpError(409, 'Telesom session is not fully connected yet.');
    }

    const recipientNumber = sanitizePhoneNumber(payload?.recipientNumber);
    const amountUsd = normalizeAmount(payload?.amountUsd);
    const transactionPin = sanitizePin(payload?.transactionPin);

    if (!recipientNumber) {
      throw new HttpError(400, 'Recipient number is required.');
    }

    if (!amountUsd || Number.parseFloat(amountUsd) <= 0) {
      throw new HttpError(400, 'Transfer amount must be greater than zero.');
    }

    const receiverMobile = toLocalReceiverFormat(recipientNumber);

    let receiverInfo;

    try {
      receiverInfo = await getReceiverInfo({
        sessionId: session.telesomSessionId,
        receiverMobile,
      });
    } catch (error) {
      throw wrapApiError(error, 400);
    }

    const receiverName =
      receiverInfo?.ReceiverInfo?.NAME || session.receiverName || '';
    session.receiverName = receiverName;
    session.updatedAt = new Date().toISOString();

    if (!payload?.confirmTransfer) {
      session.lastMessage = receiverName
        ? `Receiver name resolved: ${receiverName}.`
        : 'Receiver lookup completed.';
      return;
    }

    if (!transactionPin || transactionPin.length < 4) {
      throw new HttpError(400, 'A 4-digit MyMerchant transaction PIN is required to confirm the transfer.');
    }

    const isInterNetwork = String(
      receiverInfo?.ReceiverInfo?.ISINTERNETWORKRECEIVER ?? '0'
    ) === '1' ? '1' : '0';

    try {
      const result = await p2pTransfer({
        sessionId: session.telesomSessionId,
        receiverMobile,
        amount: amountUsd,
        receiverName,
        pin: transactionPin,
        description: payload?.description || '',
        isInterNetwork,
      });

      const newBalance = normalizeAmount(result?.transferInfo?.currentBalance);

      if (newBalance) {
        session.balanceUsd = newBalance;
      }

      session.lastMessage =
        result?.replyMessage || `Transferred $${amountUsd} to ${receiverName || receiverMobile}.`;
      session.updatedAt = new Date().toISOString();
    } catch (error) {
      throw wrapApiError(error, 502);
    }
  }
}
