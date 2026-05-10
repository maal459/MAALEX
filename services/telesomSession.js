// On-device Telesom session manager. Replaces the Fly.io backend's
// telesomService.js — same shape (snapshot, recentEvents, autoTransfer),
// but runs inside the React Native app and dispatches API calls through
// the hidden WebView bridge. Auto-transfer monitor only runs while the
// app is in the foreground.

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  activityReport,
  balanceQuery,
  customerLogin,
  getReceiverInfo,
  p2pTransfer,
  secondAuthentication,
  showMiniStatement,
} from './telesom';
import {
  fireWebViewTransferFromSms,
  setAutoEventListener,
  startWebViewAutoLoop,
  stopWebViewAutoLoop,
} from './telesomBridge';

const RECEIVER_CACHE_STORAGE_KEY = '@maalex/receiver-cache';

const AUTO_TRANSFER_DEFAULT_TRIGGER_BALANCE_USD = '600';
const AUTO_TRANSFER_MINIMUM_TRIGGER_USD = 0;
const MONITOR_INTERVAL_IDLE_MS = 1_200;
const MONITOR_INTERVAL_ACTIVE_MS = 200;
const ACTIVE_WINDOW_AFTER_CHANGE_MS = 60_000;
const RATE_LIMIT_BACKOFF_INITIAL_MS = 8_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 60_000;
const NETWORK_FAILURE_BACKOFF_MS = 5_000;
const RECENT_EVENTS_LIMIT = 20;
const RATE_LIMIT_PATTERN = /too\s*many\s*requests|rate\s*limit|throttle/i;
const NETWORK_FAILURE_PATTERN = /not mounted|did not load|timed out|reloaded|network|fetch/i;
const SESSION_EXPIRED_PATTERN = /session\s*(?:has\s*)?(?:expired|invalid|not\s*found|inactive|terminated)|(?:re)?login\s*required|sign\s*in\s*again|unauthor/i;

const LOGIN_ROUTE = '#/login';
const SECOND_AUTH_ROUTE = '#/second-authentication';
const DASHBOARD_ROUTE = '#/dashboard';

const DEFAULT_CURRENCY = '840';

const sanitizePhoneNumber = (value) => String(value ?? '').replace(/\s+/g, '').trim();
const normalizeAmount = (value) => String(value ?? '').replace(/,/g, '').trim();
const parseAmountNumber = (value) => Number.parseFloat(normalizeAmount(value));
const formatAmountForTransfer = (value) => {
  if (!Number.isFinite(value)) return '';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
};
const sanitizePin = (value) => String(value ?? '').replace(/\D/g, '').trim();

const toLocalReceiverFormat = (raw) => {
  let value = sanitizePhoneNumber(raw).replace(/^\+/, '');
  if (value.startsWith('252')) value = value.slice(3);
  if (!value.startsWith('0')) value = `0${value}`;
  return value;
};

const toUsernameFormat = (raw) => {
  let value = sanitizePhoneNumber(raw).replace(/^\+/, '');
  if (value.startsWith('0')) value = `252${value.slice(1)}`;
  else if (!value.startsWith('252')) value = `252${value}`;
  return value;
};

const pickUsdAccount = (accountInformation) => {
  if (!Array.isArray(accountInformation) || accountInformation.length === 0) return null;
  return (
    accountInformation.find(
      (a) => String(a.currencyName).toUpperCase() === 'USD'
    ) ||
    accountInformation.find((a) => a.isDefaultAccount) ||
    accountInformation[0]
  );
};

const normalizeAutoTransferSettings = (payload = {}, current = {}) => {
  const recipientNumber = sanitizePhoneNumber(
    payload?.recipientNumber ?? current.recipientNumber ?? ''
  );
  const amountUsd = normalizeAmount(payload?.amountUsd ?? current.amountUsd ?? '');
  const triggerBalanceUsd = normalizeAmount(
    payload?.triggerBalanceUsd ??
      current.triggerBalanceUsd ??
      AUTO_TRANSFER_DEFAULT_TRIGGER_BALANCE_USD
  );
  const description = String(payload?.description ?? current.description ?? '').trim();
  const pin = sanitizePin(payload?.pin ?? current.pin ?? '');
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

const recordEvent = (state, type, message, extra = {}) => {
  if (!Array.isArray(state.recentEvents)) state.recentEvents = [];
  state.recentEvents.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    message,
    at: new Date().toISOString(),
    ...extra,
  });
  if (state.recentEvents.length > RECENT_EVENTS_LIMIT) {
    state.recentEvents = state.recentEvents.slice(-RECENT_EVENTS_LIMIT);
  }
};

const buildSnapshot = (state) => {
  if (!state) return null;

  let status = 'pending';
  let route = LOGIN_ROUTE;

  if (!state.telesomSessionId) {
    status = state.requiresAuthenticationCode ? 'otp_required' : 'signed_out';
    route = LOGIN_ROUTE;
  } else if (state.requiresAuthenticationCode) {
    status = 'otp_required';
    route = SECOND_AUTH_ROUTE;
  } else if (state.balanceUsd) {
    status = 'connected';
    route = DASHBOARD_ROUTE;
  } else if (state.accountInformation?.length) {
    status = 'loading_balance';
    route = DASHBOARD_ROUTE;
  } else {
    status = 'verifying_otp';
    route = SECOND_AUTH_ROUTE;
  }

  return {
    sessionId: state.id,
    status,
    requiresAuthenticationCode: Boolean(state.requiresAuthenticationCode),
    sessionExpired: Boolean(state.sessionExpired),
    route,
    accountLabel: state.accountLabel || '',
    accountHolderName: state.accountHolderName || '',
    balanceUsd: state.balanceUsd || '',
    receiverName: state.receiverName || '',
    lastUpdatedAt: state.updatedAt,
    lastMessage: state.lastMessage || '',
    recentEvents: Array.isArray(state.recentEvents)
      ? state.recentEvents.slice(-RECENT_EVENTS_LIMIT)
      : [],
    autoTransfer: {
      recipientNumber: state.autoTransfer?.recipientNumber || '',
      amountUsd: state.autoTransfer?.amountUsd || '',
      triggerBalanceUsd:
        state.autoTransfer?.triggerBalanceUsd || AUTO_TRANSFER_DEFAULT_TRIGGER_BALANCE_USD,
      enabled: Boolean(state.autoTransfer?.enabled),
      armed: Boolean(state.autoTransfer?.armed),
      lastTriggeredAt: state.autoTransfer?.lastTriggeredAt || '',
      lastError: state.autoTransfer?.lastError || '',
      pinConfigured: Boolean(state.autoTransfer?.pin),
    },
  };
};

class TelesomSessionManager {
  constructor() {
    this.state = null;
    this.listeners = new Set();
    this.monitorTimer = null;
    this.receiverInfoInflight = new Map();
    this.persistentReceiverCache = {};
    this.webViewLoopActive = false;
    this.webViewLoopHash = '';
    setAutoEventListener((event) => this.handleAutoEvent(event));
    // Fire-and-forget hydration; ready well before any sign-in completes.
    AsyncStorage.getItem(RECEIVER_CACHE_STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            this.persistentReceiverCache = parsed;
          }
        } catch {
          // ignore corrupt cache
        }
      })
      .catch(() => {});
  }

  persistReceiverCache(cache) {
    AsyncStorage.setItem(
      RECEIVER_CACHE_STORAGE_KEY,
      JSON.stringify(cache || {})
    ).catch(() => {});
  }

  // ---- subscription ------------------------------------------------------

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  emit() {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Ignore listener errors.
      }
    }
  }

  getSnapshot() {
    return this.state ? buildSnapshot(this.state) : null;
  }

  hasSession() {
    return Boolean(this.state);
  }

  // ---- lifecycle ---------------------------------------------------------

  async createSession({ loginIdentifier, loginPassword, currency, autoTransfer }) {
    const username = toUsernameFormat(loginIdentifier);

    if (!username || username === '252') {
      throw new Error('Login identifier is required.');
    }

    if (!String(loginPassword || '').trim()) {
      throw new Error('Login password is required.');
    }

    this.destroySession();

    // Don't emit state until Telesom actually responds. Otherwise consumers
    // see a snapshot with sessionId set but no telesomSessionId/OTP flag,
    // and isSignedIn momentarily flips true → the UI jumps past the sign-in
    // form before the OTP card has a chance to render.
    let result;
    try {
      result = await customerLogin({
        username,
        password: String(loginPassword),
        currency: String(currency || DEFAULT_CURRENCY),
      });
    } catch (err) {
      this.state = null;
      this.emit();
      throw err;
    }

    this.state = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      username,
      currency: String(currency || DEFAULT_CURRENCY),
      telesomSessionId: result.sessionId || '',
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
      currentRateLimitBackoffMs: RATE_LIMIT_BACKOFF_INITIAL_MS,
      lastBalanceChangeAt: 0,
      sessionExpired: false,
      receiverInfoCache: { ...(this.persistentReceiverCache || {}) },
      requiresAuthenticationCode: Boolean(result.otpRequired),
      accountLabel: '',
      balanceUsd: '',
      receiverName: '',
      lastMessage: result.replyMessage || '',
      autoTransfer: {
        ...normalizeAutoTransferSettings(autoTransfer),
        armed: true,
        isRunning: false,
        lastTriggeredAt: '',
        lastError: '',
      },
    };

    this.reconcileMonitor();
    this.emit();

    return this.getSnapshot();
  }

  async submitAuthenticationCode(code, autoTransfer) {
    if (!this.state) throw new Error('Sign in before submitting the SMS code.');
    if (!this.state.telesomSessionId) {
      throw new Error('Sign in again — the Telesom session is missing.');
    }
    if (!String(code || '').trim()) {
      throw new Error('Authentication code is required.');
    }

    this.applyAutoTransfer(autoTransfer);

    try {
      const profile = await secondAuthentication({
        sessionId: this.state.telesomSessionId,
        code,
      });

      if (profile?.sessionId && profile.sessionId !== this.state.telesomSessionId) {
        this.state.telesomSessionId = profile.sessionId;
      }

      this.state.secureId = String(code || '').replace(/\D/g, '');
      this.state.subscriptionId = profile.subscriptionId || this.state.subscriptionId;
      this.state.partnerId = profile.partnerId || '';
      this.state.partnerUID = profile.partnerUID || '';
      this.state.accountHolderName = String(profile.name || '').trim();
      this.state.accountInformation = profile.accountInformation || [];
      this.state.rawServiceInformation = profile.serviceInformation || [];
      this.state.account = pickUsdAccount(this.state.accountInformation);

      if (!this.state.account) {
        throw new Error('Telesom did not return any accounts for this user.');
      }

      this.state.accountLabel = this.state.account.accountTitle || '';
      this.state.requiresAuthenticationCode = false;
      this.state.lastMessage = 'Authentication accepted.';
      this.state.updatedAt = new Date().toISOString();
      this.emit();

      const warmPromise = this.warmReceiverCache().catch(() => {});
      await this.refreshAccountData();
      await warmPromise;
      console.log('[diag] signed in', {
        recipient: this.state.autoTransfer?.recipientNumber || '(empty)',
        pinLen: this.state.autoTransfer?.pin?.length || 0,
        triggerBalanceUsd: this.state.autoTransfer?.triggerBalanceUsd,
        enabled: this.state.autoTransfer?.enabled,
      });
      this.reconcileWebViewLoop();
      return this.getSnapshot();
    } catch (err) {
      if (this.state) {
        this.state.lastMessage = err.message;
        this.state.updatedAt = new Date().toISOString();
        this.emit();
      }
      throw err;
    }
  }

  async refreshBalance(payload = {}) {
    if (!this.state) throw new Error('Sign in before refreshing balance.');
    this.applyAutoTransfer(payload?.autoTransfer);

    if (this.state.requiresAuthenticationCode) return this.getSnapshot();
    if (!this.state.account) {
      throw new Error('Finish authentication before refreshing balance.');
    }

    await this.refreshAccountData();
    return this.getSnapshot();
  }

  async transfer(payload) {
    if (!this.state) throw new Error('Sign in before sending money.');
    await this.performTransfer(payload);
    return this.getSnapshot();
  }

  async getActivityReport({ startDate, endDate }) {
    if (!this.state) throw new Error('Sign in before loading reports.');
    if (this.state.requiresAuthenticationCode || !this.state.account) {
      throw new Error('Finish authentication before loading reports.');
    }
    if (!startDate || !endDate) {
      throw new Error('Report start and end dates are required.');
    }

    const result = await activityReport({
      sessionId: this.state.telesomSessionId,
      startDate,
      endDate,
    });

    const rows = Array.isArray(result?.activityReport) ? result.activityReport : [];

    return rows.map((row, index) => {
      const debit = Number.parseFloat(row?.DEBIT ?? 0) || 0;
      const credit = Number.parseFloat(row?.CREDIT ?? 0) || 0;
      const direction = credit > 0 ? 'in' : debit > 0 ? 'out' : 'unknown';
      const amount = direction === 'in' ? credit : debit;

      return {
        id: String(row?.TRANSFERID || row?.TRANSACTIONID || `${index}-${row?.TRANSFERDATE || ''}`),
        transferId: String(row?.TRANSFERID || ''),
        transactionId: String(row?.TRANSACTIONID || ''),
        direction,
        amount: amount ? String(amount) : '',
        debit,
        credit,
        counterparty: String(row?.OTHERPARTYACCOUNT || '').trim(),
        date: String(row?.TRANSFERDATE || ''),
        description: String(row?.DESCRIPTION || ''),
        balanceAfter:
          row?.BALANCE !== undefined && row?.BALANCE !== null
            ? String(row.BALANCE)
            : '',
        accountBalance:
          row?.ACCOUNTBALANCE !== undefined && row?.ACCOUNTBALANCE !== null
            ? String(row.ACCOUNTBALANCE)
            : '',
        status: row?.TRANSFERSTATUS,
        accountTitle: String(row?.ACCOUNTTITLE || ''),
        username: String(row?.USERNAME || ''),
        raw: row,
      };
    });
  }

  async getRecentTransactions() {
    if (!this.state) throw new Error('Sign in before loading transactions.');
    if (this.state.requiresAuthenticationCode || !this.state.account) {
      throw new Error('Finish authentication before loading transactions.');
    }

    const result = await showMiniStatement({
      sessionId: this.state.telesomSessionId,
    });

    const rows = Array.isArray(result?.transactionInfo) ? result.transactionInfo : [];

    return rows.map((row, index) => ({
      id: String(
        row?.['Transaction-Id'] ||
          row?.['Transfer-Id'] ||
          `${index}-${row?.['Transaction-Date'] || ''}`
      ),
      amount: String(row?.['Tx-Amount'] ?? row?.['TxAmount'] ?? row?.amount ?? ''),
      direction: String(
        row?.['Tx-Type'] || row?.['Transaction-Type'] || row?.direction || ''
      ).toLowerCase(),
      counterparty: String(
        row?.['Other-Party'] ||
          row?.['Counterparty'] ||
          row?.['Receiver-Name'] ||
          row?.['Sender-Name'] ||
          ''
      ),
      date: String(row?.['Transaction-Date'] || row?.['Tx-Date'] || row?.date || ''),
      description: String(
        row?.description || row?.['Description'] || row?.['Reply-Message'] || ''
      ),
      balanceAfter: String(row?.['Current-Balance'] || row?.currentBalance || ''),
      raw: row,
    }));
  }

  destroySession() {
    this.stopMonitor();
    if (this.webViewLoopActive) {
      stopWebViewAutoLoop().catch(() => {});
      this.webViewLoopActive = false;
      this.webViewLoopHash = '';
    }
    this.state = null;
    this.receiverInfoInflight.clear();
    this.emit();
  }

  // Used by AppState handlers to pause polling when backgrounded and to force
  // an immediate refresh on foreground without waiting for the next tick.
  pauseMonitor() {
    this.stopMonitor();
    if (this.webViewLoopActive) {
      stopWebViewAutoLoop().catch(() => {});
      // Mark as paused-but-configured so resume can re-arm with the same hash.
      this.webViewLoopActive = false;
    }
  }

  resumeMonitor() {
    if (!this.state?.autoTransfer?.enabled) return;
    // Clear any rate-limit cooldown that elapsed in the background so we
    // don't sit idle when the user comes back.
    if (this.state.rateLimitedUntil && Date.now() >= this.state.rateLimitedUntil) {
      this.state.rateLimitedUntil = 0;
    }
    // Prefer the WebView loop when preconditions are met; fall back to RN.
    this.webViewLoopHash = '';
    this.reconcileWebViewLoop();
    if (!this.webViewLoopActive) {
      this.scheduleNextTick(50);
    }
  }

  // ─── In-WebView loop control ───────────────────────────────────────────
  // When all preconditions are met we hand the detect-and-send loop to the
  // WebView so it runs same-origin with zero RN bridge crossings on the hot
  // path. The RN-side tickMonitor stops to avoid double-triggering.

  reconcileWebViewLoop() {
    const state = this.state;
    if (!state) {
      if (this.webViewLoopActive) {
        stopWebViewAutoLoop().catch(() => {});
        this.webViewLoopActive = false;
        this.webViewLoopHash = '';
      }
      return;
    }

    const at = state.autoTransfer;
    const recipientNumber = sanitizePhoneNumber(at?.recipientNumber || '');
    const receiverMobile = recipientNumber ? toLocalReceiverFormat(recipientNumber) : '';
    const cachedReceiver = receiverMobile && state.receiverInfoCache?.[receiverMobile];

    // We start the in-WebView fast loop as soon as we have everything b2p
    // strictly requires (sessionId + recipient + pin). The receiver-name
    // lookup is informational — if it failed, we proceed with an empty name
    // and assume same-network. This keeps the fast path active even when
    // /api/account/find rejects the number for whatever reason.
    const ready =
      at?.enabled &&
      !state.requiresAuthenticationCode &&
      state.telesomSessionId &&
      state.account &&
      receiverMobile &&
      at.pin;

    if (!ready) {
      console.log('[diag] webview loop NOT ready', {
        enabled: !!at?.enabled,
        requiresOtp: state.requiresAuthenticationCode,
        hasSessionId: !!state.telesomSessionId,
        hasAccount: !!state.account,
        receiverMobile: receiverMobile || '(empty)',
        hasPin: !!at?.pin,
      });
      if (this.webViewLoopActive) {
        stopWebViewAutoLoop().catch(() => {});
        this.webViewLoopActive = false;
        this.webViewLoopHash = '';
      }
      return;
    }

    const cfg = {
      sessionId: state.telesomSessionId,
      recipientMobile: receiverMobile,
      recipientName: cachedReceiver?.ReceiverInfo?.NAME || state.receiverName || '',
      isInterNetwork:
        String(cachedReceiver?.ReceiverInfo?.ISINTERNETWORKRECEIVER ?? '0') === '1' ? '1' : '0',
      threshold: parseAmountNumber(at.triggerBalanceUsd) || 0,
      pin: at.pin,
      description: at.description || 'MAALEX automatic transfer',
    };

    const hash = [
      cfg.sessionId,
      cfg.recipientMobile,
      cfg.recipientName,
      cfg.isInterNetwork,
      String(cfg.threshold),
      cfg.pin,
      cfg.description,
    ].join('|');

    if (this.webViewLoopActive && hash === this.webViewLoopHash) return;

    console.log('[diag] STARTING webview loop', { recipient: cfg.recipientMobile, threshold: cfg.threshold });
    this.webViewLoopHash = hash;
    this.webViewLoopActive = true;
    // Stop RN-side polling — WebView owns the hot path now.
    this.stopMonitor();
    startWebViewAutoLoop(cfg).catch(() => {
      this.webViewLoopActive = false;
      this.webViewLoopHash = '';
    });
  }

  handleAutoEvent(event) {
    const state = this.state;
    if (!state) return;

    switch (event.type) {
      case 'auto_started':
        state.lastMessage = 'Lightning auto-transfer armed.';
        this.emit();
        break;

      case 'auto_stopped':
        // No-op; reconcile already cleared the flag.
        break;

      case 'auto_observed': {
        // Track Telesom's authoritative balance internally for the drain
        // calculation and monitor pacing, but DO NOT mirror it onto
        // state.balanceUsd. The merchant's displayed balance only ticks
        // when an outbound transfer actually completes — a customer
        // watching the merchant's phone never sees their payment briefly
        // inflate the balance before it gets swept out.
        if (event.balance !== undefined && event.balance !== null) {
          const numeric = Number(event.balance);
          if (Number.isFinite(numeric) && numeric !== state.lastObservedBalance) {
            state.lastObservedBalance = numeric;
            state.lastBalanceChangeAt = Date.now();
          }
        }
        state.updatedAt = new Date().toISOString();
        this.emit();
        break;
      }

      case 'auto_transfer_started': {
        if (state.autoTransfer) state.autoTransfer.isRunning = true;
        state.lastMessage = `Sending $${event.amount} to ${state.autoTransfer?.recipientNumber || ''}…`;
        this.emit();
        break;
      }

      case 'auto_transfer_complete': {
        if (state.autoTransfer) {
          state.autoTransfer.isRunning = false;
          state.autoTransfer.armed = true;
          state.autoTransfer.lastTriggeredAt = new Date().toISOString();
          state.autoTransfer.lastError = '';
        }
        if (event.balance) {
          const nb = formatAmountForTransfer(parseAmountNumber(event.balance));
          if (nb) state.balanceUsd = nb;
        }
        state.lastBalanceChangeAt = Date.now();
        state.lastMessage =
          `Sent $${event.amount} to ${state.autoTransfer?.recipientNumber || ''}` +
          (event.elapsedMs ? ` in ${event.elapsedMs}ms.` : '.');
        recordEvent(
          state,
          'auto_transfer',
          `Sent $${event.amount} to ${state.autoTransfer?.recipientNumber || ''}` +
            (event.elapsedMs ? ` (${event.elapsedMs}ms).` : '.'),
          {
            amount: event.amount,
            recipient: state.autoTransfer?.recipientNumber || '',
            elapsedMs: event.elapsedMs,
            source: 'webview-loop',
          }
        );
        this.emit();
        break;
      }

      case 'auto_transfer_failed': {
        if (state.autoTransfer) {
          state.autoTransfer.isRunning = false;
          state.autoTransfer.armed = true;
          state.autoTransfer.lastError =
            event.replyMessage || event.error || 'Transfer failed.';
        }
        const msg = event.replyMessage || event.error || 'Transfer failed.';
        state.lastMessage = msg;
        // If the WebView reports a session-expired condition, tear down so
        // the user is prompted to re-authenticate.
        if (SESSION_EXPIRED_PATTERN.test(msg)) {
          state.requiresAuthenticationCode = false;
          state.telesomSessionId = '';
          state.account = null;
          state.balanceUsd = '';
          state.sessionExpired = true;
          recordEvent(state, 'rate_limited', 'Session expired — sign in again.');
          this.webViewLoopActive = false;
          this.webViewLoopHash = '';
          stopWebViewAutoLoop().catch(() => {});
        }
        this.emit();
        break;
      }

      case 'auto_error':
        // Transient; the WebView loop self-recovers with its own backoff.
        break;

      default:
        break;
    }
  }

  // Hot path: an external signal (Zaad SMS) just told us money arrived.
  // Skip waiting for the next poll and go straight to transfer for the
  // observed amount. The `isRunning` guard inside maybeTriggerAutoTransfer
  // prevents this from racing with the WebView loop on the same credit.
  async notifyIncomingPayment({ amount, source = 'sms' } = {}) {
    const state = this.state;
    if (!state) return false;
    if (state.requiresAuthenticationCode || !state.account) return false;
    if (!state.autoTransfer?.enabled) return false;

    const credited = Number.parseFloat(String(amount));
    if (!Number.isFinite(credited) || credited <= 0) return false;

    // Track internally for monitor pacing and the drain calc, but DO NOT
    // mutate state.balanceUsd. The displayed balance only ticks on a
    // successful outbound transfer, so a customer watching the merchant's
    // phone never sees their own credit puff up the balance briefly. The
    // 'balance_increase' event is also skipped for the same reason.
    const previousObserved = state.lastObservedBalance ?? parseAmountNumber(state.balanceUsd) ?? 0;
    state.lastObservedBalance = previousObserved + credited;
    state.lastBalanceChangeAt = Date.now();
    this.emit();

    // Fast path: if the WebView loop is running, hand the SMS straight to it
    // — same-origin fetch, no RN bridge crossing on the b2p call.
    if (this.webViewLoopActive) {
      fireWebViewTransferFromSms({ delta: credited }).catch(() => {});
      return true;
    }

    if (state.autoTransfer.isRunning) return false;

    try {
      return await this.forwardCreditAmount(credited);
    } catch {
      return false;
    } finally {
      this.refreshAccountData().catch(() => {});
    }
  }


  // ---- auto-transfer monitor --------------------------------------------

  applyAutoTransfer(payload) {
    if (!this.state || !payload) return;

    const previous = this.state.autoTransfer || {
      armed: true,
      isRunning: false,
      lastTriggeredAt: '',
      lastError: '',
    };
    const next = normalizeAutoTransferSettings(payload, previous);
    const changed =
      previous.recipientNumber !== next.recipientNumber ||
      previous.amountUsd !== next.amountUsd ||
      previous.triggerBalanceUsd !== next.triggerBalanceUsd ||
      previous.description !== next.description ||
      previous.pin !== next.pin;

    this.state.autoTransfer = {
      ...previous,
      ...next,
      armed: changed ? true : previous.armed ?? true,
      isRunning: previous.isRunning ?? false,
      lastTriggeredAt: changed ? '' : previous.lastTriggeredAt || '',
      lastError: changed ? '' : previous.lastError || '',
    };

    this.reconcileMonitor();
    this.reconcileWebViewLoop();
    this.emit();

    if (changed) {
      this.warmReceiverCache().catch(() => {});
    }
  }

  async fetchReceiverInfo(receiverMobile) {
    const state = this.state;
    if (!state) throw new Error('No active session.');

    if (!state.receiverInfoCache) state.receiverInfoCache = {};
    if (state.receiverInfoCache[receiverMobile]) {
      return state.receiverInfoCache[receiverMobile];
    }

    if (!this.receiverInfoInflight) this.receiverInfoInflight = new Map();
    const existing = this.receiverInfoInflight.get(receiverMobile);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const info = await getReceiverInfo({
          sessionId: state.telesomSessionId,
          receiverMobile,
        });
        if (this.state) {
          if (!this.state.receiverInfoCache) this.state.receiverInfoCache = {};
          this.state.receiverInfoCache[receiverMobile] = info;
        }
        // Persist for next cold start so we never wait on a warmup RTT.
        this.persistentReceiverCache = {
          ...(this.persistentReceiverCache || {}),
          [receiverMobile]: info,
        };
        this.persistReceiverCache(this.persistentReceiverCache);
        return info;
      } finally {
        this.receiverInfoInflight.delete(receiverMobile);
      }
    })();

    this.receiverInfoInflight.set(receiverMobile, promise);
    return promise;
  }

  async warmReceiverCache() {
    const state = this.state;
    if (!state) return;
    if (state.requiresAuthenticationCode || !state.telesomSessionId) return;

    const recipient = sanitizePhoneNumber(state.autoTransfer?.recipientNumber || '');
    if (!recipient) return;

    const receiverMobile = toLocalReceiverFormat(recipient);

    try {
      const receiverInfo = await this.fetchReceiverInfo(receiverMobile);
      const name = receiverInfo?.ReceiverInfo?.NAME;
      if (this.state && name && !this.state.receiverName) {
        this.state.receiverName = name;
        this.emit();
      }
      // Receiver info just became available — start the WebView loop now
      // that all preconditions (sessionId, recipient, pin, cached receiver)
      // are simultaneously satisfied.
      this.reconcileWebViewLoop();
    } catch {
      // Best-effort warmup; performTransfer will retry on demand.
    }
  }

  stopMonitor() {
    if (this.monitorTimer) {
      clearTimeout(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  reconcileMonitor() {
    const enabled = Boolean(this.state?.autoTransfer?.enabled);

    if (!enabled) {
      this.stopMonitor();
      return;
    }

    // The in-WebView loop owns the hot path when active. Skip RN-side
    // polling so we don't double-trigger and don't add bridge overhead.
    if (this.webViewLoopActive) {
      this.stopMonitor();
      return;
    }

    if (this.monitorTimer) return;
    this.scheduleNextTick(MONITOR_INTERVAL_ACTIVE_MS);
  }

  scheduleNextTick(delayMs) {
    if (!this.state?.autoTransfer?.enabled) return;
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    this.monitorTimer = setTimeout(() => {
      this.monitorTimer = null;
      this.tickMonitor()
        .catch(() => {})
        .finally(() => this.scheduleNextTick(this.computeNextDelay()));
    }, Math.max(50, delayMs));
  }

  computeNextDelay() {
    const state = this.state;
    if (!state) return MONITOR_INTERVAL_IDLE_MS;

    const now = Date.now();

    if (state.rateLimitedUntil && now < state.rateLimitedUntil) {
      return state.rateLimitedUntil - now;
    }

    const lastChange = state.lastBalanceChangeAt || 0;
    const sinceChange = now - lastChange;
    if (lastChange && sinceChange < ACTIVE_WINDOW_AFTER_CHANGE_MS) {
      return MONITOR_INTERVAL_ACTIVE_MS;
    }

    return MONITOR_INTERVAL_IDLE_MS;
  }

  async tickMonitor() {
    const state = this.state;
    if (!state) return;
    if (state.autoTransfer?.isRunning) return;
    if (state.requiresAuthenticationCode || !state.account) return;
    if (state.rateLimitedUntil && Date.now() < state.rateLimitedUntil) return;

    try {
      // Mini-statement is the fastest API signal: a new credit row appears
      // here before the balance aggregate updates on Telesom's side. We pull
      // the running balance straight from the latest row.
      await this.pollPaymentSignal();
      state.currentRateLimitBackoffMs = RATE_LIMIT_BACKOFF_INITIAL_MS;
    } catch (err) {
      state.lastMessage = err.message;
      state.updatedAt = new Date().toISOString();

      const msg = err.message || '';

      if (SESSION_EXPIRED_PATTERN.test(msg)) {
        // Telesom dropped our session. Surface it cleanly so the UI can
        // prompt the user to sign in again, but keep config intact.
        state.requiresAuthenticationCode = false;
        state.telesomSessionId = '';
        state.account = null;
        state.balanceUsd = '';
        state.sessionExpired = true;
        state.lastMessage = 'Session expired — sign in again.';
        recordEvent(
          state,
          'rate_limited',
          'Session expired — sign in again.'
        );
        this.stopMonitor();
        this.emit();
        return;
      }

      if (RATE_LIMIT_PATTERN.test(msg)) {
        const current =
          state.currentRateLimitBackoffMs || RATE_LIMIT_BACKOFF_INITIAL_MS;
        const backoff = Math.min(current, RATE_LIMIT_BACKOFF_MAX_MS);
        state.rateLimitedUntil = Date.now() + backoff;
        state.currentRateLimitBackoffMs = Math.min(
          current * 2,
          RATE_LIMIT_BACKOFF_MAX_MS
        );
        recordEvent(
          state,
          'rate_limited',
          `Telesom rate limited us — pausing for ${Math.round(backoff / 1000)}s.`
        );
      } else if (NETWORK_FAILURE_PATTERN.test(msg)) {
        state.rateLimitedUntil = Date.now() + NETWORK_FAILURE_BACKOFF_MS;
        recordEvent(
          state,
          'rate_limited',
          `Network unreachable — pausing for ${Math.round(
            NETWORK_FAILURE_BACKOFF_MS / 1000
          )}s.`
        );
      }

      this.emit();
    }
  }

  // ---- core operations ---------------------------------------------------

  async pollPaymentSignal() {
    const state = this.state;
    if (!state) return;

    // /api/report/activity reflects new credits in real time, while
    // /api/account/balance and /api/account/transactions are server-side
    // cached and lag behind. Always poll the activity endpoint so the
    // RN-side fallback path matches the WebView loop's freshness.
    const ymd = (d) => {
      const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const result = await activityReport({
      sessionId: state.telesomSessionId,
      startDate: ymd(yesterday),
      endDate: ymd(now),
    });

    const rows = Array.isArray(result?.activityReport) ? result.activityReport : [];
    if (rows.length === 0) {
      // Brand-new account, no transactions yet — fall back to balance.
      await this.refreshAccountData();
      return;
    }

    // activityReport is ordered oldest-first; newest is at the tail.
    const latest = rows[rows.length - 1];
    const latestId = String(latest?.TRANSFERID ?? latest?.TRANSACTIONID ?? '');
    const balanceFromRow = normalizeAmount(
      latest?.ACCOUNTBALANCE ?? latest?.BALANCE ?? ''
    );

    // Do NOT mirror balanceFromRow onto state.balanceUsd — the displayed
    // balance only updates after a successful forward (see performTransfer
    // and the auto_transfer_complete handler). We still use balanceFromRow
    // locally below for the drain calculation.
    state.accountLabel =
      latest?.ACCOUNTTITLE || state.accountLabel;
    state.lastMessage = 'Activity refreshed.';
    state.updatedAt = new Date().toISOString();
    if (balanceFromRow) {
      const obs = parseAmountNumber(balanceFromRow);
      if (Number.isFinite(obs)) state.lastObservedBalance = obs;
    }

    // Detect new credit transactions since the last poll. The first poll
    // after sign-in just baselines the marker; subsequent polls trigger
    // on any new credit row. We sum CREDITs across all *new* rows so that
    // multiple incoming payments inside a single tick window aren't lost.
    const lastSeen = state.lastSeenTxId || '';
    let creditedTotal = 0;

    if (lastSeen) {
      // Walk newest → oldest until we hit the last seen id.
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        const id = String(row?.TRANSFERID ?? row?.TRANSACTIONID ?? '');
        if (!id || id === lastSeen) break;
        const credit = parseAmountNumber(row?.CREDIT ?? 0);
        if (Number.isFinite(credit) && credit > 0) {
          creditedTotal += credit;
        }
      }
    }

    state.lastSeenTxId = latestId || lastSeen;

    // Drain any balance sitting above the keep-amount as well as the new
    // incoming credit. Forward whichever is larger so a credit that only
    // partially exceeds threshold still passes through cleanly.
    // Use the locally-observed balance (from the activity row) — we do
    // NOT touch state.balanceUsd because the display is intentionally
    // pinned to the post-forward value to keep the merchant's view stable
    // for any customer watching.
    const threshold = parseAmountNumber(state.autoTransfer?.triggerBalanceUsd);
    const balanceNumeric = parseAmountNumber(balanceFromRow);
    const excess =
      Number.isFinite(threshold) && Number.isFinite(balanceNumeric) && balanceNumeric > threshold
        ? balanceNumeric - threshold
        : 0;
    // First poll after sign-in baselines the tx marker; on that poll we
    // still want to drain pre-existing excess so the merchant doesn't sit
    // on stale funds waiting for the next credit.
    const isBaseline = !lastSeen;
    const forwardAmount = Math.max(creditedTotal, excess);
    const willForward =
      forwardAmount > 0 && (creditedTotal > 0 || isBaseline);

    if (creditedTotal > 0 || (lastSeen && latestId !== lastSeen) || (isBaseline && excess > 0)) {
      state.lastBalanceChangeAt = Date.now();
      console.log('[diag] poll change', {
        rows: rows.length,
        latestId,
        lastSeen: lastSeen || '(baseline)',
        observedBalance: balanceFromRow,
        creditedTotal,
        excess,
        forwardAmount,
        willForward,
      });
    }

    // Intentionally NOT recording a 'balance_increase' event — the
    // merchant-as-passthrough view should only surface outbound transfers.
    this.emit();

    if (willForward) {
      await this.forwardCreditAmount(forwardAmount);
    }
  }

  async refreshAccountData() {
    const state = this.state;
    if (!state) return;

    const result = await balanceQuery({
      sessionId: state.telesomSessionId,
    });

    const targetAccountId = String(state.account?.accountId ?? '');

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

    if (balanceString) {
      const obs = parseAmountNumber(balanceString);
      if (Number.isFinite(obs)) {
        if (state.lastObservedBalance !== obs) {
          state.lastObservedBalance = obs;
          state.lastBalanceChangeAt = Date.now();
        }
      }
      // Seed the displayed balance only the FIRST time (on sign-in). After
      // that, state.balanceUsd is pinned to the post-forward value and
      // only updates inside performTransfer / auto_transfer_complete so
      // the merchant's screen stays stable for any customer watching.
      if (!state.balanceUsd) {
        state.balanceUsd = balanceString;
      }
    }

    state.accountLabel = result.accountTitle || state.accountLabel;
    state.lastMessage = 'Balance refreshed.';
    state.updatedAt = new Date().toISOString();

    // Balance refreshes are reconciliation only — they never trigger
    // transfers. Transfers fire on observed CREDIT rows (poll/SMS).
    this.emit();
  }

  // Forwards `creditedAmount` to the configured recipient. Called when a
  // new CREDIT row appears in /api/report/activity or when an SMS lands.
  // We do NOT consult balance or threshold — we send exactly what came in.
  async forwardCreditAmount(creditedAmount) {
    const state = this.state;
    if (!state) {
      console.log('[diag] forward bail: no state');
      return false;
    }

    const settings = state.autoTransfer;
    if (!settings?.enabled) {
      console.log('[diag] forward bail: autoTransfer not enabled', {
        recipient: settings?.recipientNumber, pinLen: settings?.pin?.length || 0,
      });
      return false;
    }
    if (settings.isRunning) {
      console.log('[diag] forward bail: already running');
      return false;
    }
    if (state.requiresAuthenticationCode) {
      console.log('[diag] forward bail: needs OTP');
      return false;
    }
    if (!settings.pin) {
      console.log('[diag] forward bail: no PIN');
      return false;
    }
    if (!settings.recipientNumber) {
      console.log('[diag] forward bail: no recipient');
      return false;
    }

    const numericAmount = Number.parseFloat(String(creditedAmount));
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      console.log('[diag] forward bail: bad amount', { creditedAmount });
      return false;
    }
    console.log('[diag] forward STARTING', { amount: numericAmount, recipient: settings.recipientNumber });

    settings.isRunning = true;
    settings.armed = false;
    settings.lastError = '';
    this.emit();

    try {
      const amountToTransfer = formatAmountForTransfer(numericAmount);

      await this.performTransfer({
        recipientNumber: settings.recipientNumber,
        amountUsd: amountToTransfer,
        description: settings.description || 'MAALEX automatic transfer',
        transactionPin: settings.pin,
        confirmTransfer: true,
      });

      settings.lastTriggeredAt = new Date().toISOString();
      state.lastBalanceChangeAt = Date.now();
      state.lastMessage = `Forwarded $${amountToTransfer} to ${settings.recipientNumber}.`;
      recordEvent(
        state,
        'auto_transfer',
        `Sent $${amountToTransfer} to ${settings.recipientNumber}.`,
        { amount: amountToTransfer, recipient: settings.recipientNumber }
      );
      this.emit();
      return true;
    } catch (err) {
      settings.armed = true;
      settings.lastError = err.message;
      state.lastMessage = err.message;
      this.emit();
      return false;
    } finally {
      if (state.autoTransfer) state.autoTransfer.isRunning = false;
    }
  }

  async performTransfer(payload) {
    const state = this.state;
    if (!state) throw new Error('No active session.');
    if (state.requiresAuthenticationCode) {
      throw new Error('Finish the MyMerchant authentication step before sending funds.');
    }
    if (!state.account) {
      throw new Error('Telesom session is not fully connected yet.');
    }

    const recipientNumber = sanitizePhoneNumber(payload?.recipientNumber);
    const amountUsd = normalizeAmount(payload?.amountUsd);
    const transactionPin = sanitizePin(payload?.transactionPin);

    if (!recipientNumber) throw new Error('Recipient number is required.');
    if (!amountUsd || Number.parseFloat(amountUsd) <= 0) {
      throw new Error('Transfer amount must be greater than zero.');
    }

    const receiverMobile = toLocalReceiverFormat(recipientNumber);

    // Try to resolve the receiver name, but don't make it block the transfer
    // — Telesom's /api/account/find can reject numbers for opaque reasons
    // (resultCode 5003/7003) even when the b2p call would succeed. We
    // attempt the transfer with an empty name and same-network default
    // when lookup fails so the user isn't stranded.
    let receiverInfo = null;
    try {
      receiverInfo = await this.fetchReceiverInfo(receiverMobile);
    } catch (lookupErr) {
      console.warn(
        `[telesomSession] receiver lookup failed for ${receiverMobile}, attempting transfer anyway: ${lookupErr.message}`
      );
    }

    const receiverName =
      receiverInfo?.ReceiverInfo?.NAME || state.receiverName || '';
    state.receiverName = receiverName;
    state.updatedAt = new Date().toISOString();

    if (!payload?.confirmTransfer) {
      state.lastMessage = receiverName
        ? `Receiver name resolved: ${receiverName}.`
        : 'Receiver lookup completed.';
      this.emit();
      return;
    }

    if (!transactionPin || transactionPin.length < 4) {
      throw new Error(
        'A 4-digit MyMerchant transaction PIN is required to confirm the transfer.'
      );
    }

    const isInterNetwork =
      String(receiverInfo?.ReceiverInfo?.ISINTERNETWORKRECEIVER ?? '0') === '1'
        ? '1'
        : '0';

    const result = await p2pTransfer({
      sessionId: state.telesomSessionId,
      receiverMobile,
      amount: amountUsd,
      receiverName,
      pin: transactionPin,
      description: payload?.description || '',
      isInterNetwork,
    });

    const newBalance = normalizeAmount(result?.transferInfo?.currentBalance);
    if (newBalance) {
      state.balanceUsd = newBalance;
      state.lastBalanceChangeAt = Date.now();
    } else if (state.balanceUsd) {
      // Telesom didn't echo the post-transfer balance: predict it locally so
      // the next monitor tick doesn't re-fire before the real value arrives.
      const predicted = parseAmountNumber(state.balanceUsd) - parseAmountNumber(amountUsd);
      if (Number.isFinite(predicted) && predicted >= 0) {
        state.balanceUsd = formatAmountForTransfer(predicted);
        state.lastBalanceChangeAt = Date.now();
      }
    }

    state.lastMessage =
      result?.replyMessage ||
      `Transferred $${amountUsd} to ${receiverName || receiverMobile}.`;
    state.updatedAt = new Date().toISOString();
    this.emit();
  }
}

const telesomSession = new TelesomSessionManager();

export default telesomSession;
