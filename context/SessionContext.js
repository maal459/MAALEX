import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import telesomSession from '../services/telesomSession';
import {
  ensureSmsPermission,
  isSmsSupported,
  subscribeToCreditSms,
} from '../services/smsListener';
import {
  ZAAD_AUTO_TRANSFER_DESCRIPTION,
  ZAAD_AUTO_TRANSFER_TARGET_NUMBER,
  ZAAD_AUTO_TRANSFER_TRIGGER_BALANCE_USD,
} from '../constants/appConfig';

const STORAGE_KEY = '@maalex/zaad-auto-transfer';

const FIXED_TRIGGER_BALANCE_USD = String(ZAAD_AUTO_TRANSFER_TRIGGER_BALANCE_USD ?? 0.01);

const sanitize = (value) => String(value ?? '').replace(/\s+/g, '').trim();

const SessionContext = createContext(null);

export const SessionProvider = ({ children }) => {
  const [hydrated, setHydrated] = useState(false);
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [recipientNumber, setRecipientNumber] = useState(
    String(ZAAD_AUTO_TRANSFER_TARGET_NUMBER || '')
  );
  const triggerBalance = FIXED_TRIGGER_BALANCE_USD;
  const [currency, setCurrency] = useState('840');
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const lastSettingsHashRef = useRef('');

  const sessionId = snapshot?.sessionId || '';
  const requiresOtp = Boolean(snapshot?.requiresAuthenticationCode);
  const sessionExpired = Boolean(snapshot?.sessionExpired);
  const isConnected = snapshot?.status === 'connected';
  const isSignedIn = Boolean(sessionId) && !requiresOtp;
  const balanceUsd = snapshot?.balanceUsd || '';
  const accountHolderName = snapshot?.accountHolderName || '';
  const accountLabel = snapshot?.accountLabel || '';
  const recentEvents = snapshot?.recentEvents || [];
  const autoTransferState = snapshot?.autoTransfer || {};

  const autoTransferConfig = useMemo(
    () => ({
      recipientNumber: sanitize(recipientNumber),
      amountUsd: '',
      triggerBalanceUsd: triggerBalance,
      description: ZAAD_AUTO_TRANSFER_DESCRIPTION,
      pin: String(pin || '').replace(/\D/g, ''),
    }),
    [recipientNumber, triggerBalance, pin]
  );

  // ─── Hydrate persisted setup form ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (cancelled || !stored) return;

        try {
          const parsed = JSON.parse(stored);
          if (parsed.loginIdentifier) setLoginIdentifier(parsed.loginIdentifier);
          if (parsed.recipientNumber) setRecipientNumber(parsed.recipientNumber);
          if (parsed.currency) setCurrency(String(parsed.currency));
          if (parsed.pin) setPin(String(parsed.pin));
          if (parsed.password) setPassword(String(parsed.password));
        } catch {
          // Ignore corrupted storage.
        }
      })
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;

    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        loginIdentifier,
        recipientNumber,
        currency,
        pin,
        password,
      })
    ).catch(() => {});
  }, [hydrated, loginIdentifier, recipientNumber, currency, pin, password]);

  // ─── Subscribe to telesomSession snapshots ──────────────────────────────
  useEffect(() => {
    const unsubscribe = telesomSession.subscribe((next) => {
      setSnapshot(next);
      if (next) setErrorMessage('');
    });
    return unsubscribe;
  }, []);

  // ─── SMS fast-path: subscribe once we're signed in (Android only) ──────
  // Zaad/Telesom credit SMS arrives ~1s before /api/report/activity reflects
  // the credit. We hand the parsed amount to telesomSession which prefers the
  // WebView loop's same-origin b2p call when active.
  useEffect(() => {
    if (!isSignedIn || !isSmsSupported()) return;

    let unsubscribe = () => {};
    let cancelled = false;

    (async () => {
      const granted = await ensureSmsPermission();
      if (cancelled || !granted) return;
      unsubscribe = subscribeToCreditSms((payload) => {
        telesomSession
          .notifyIncomingPayment({ amount: payload.amount, source: 'sms' })
          .catch(() => {});
      });
    })();

    return () => {
      cancelled = true;
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    };
  }, [isSignedIn]);

  // ─── Push auto-transfer settings into the session whenever they change ──
  useEffect(() => {
    if (!sessionId || requiresOtp || !isConnected) return;

    const hash = `${autoTransferConfig.recipientNumber}|${autoTransferConfig.triggerBalanceUsd}|${autoTransferConfig.pin ? '1' : '0'}`;
    if (hash === lastSettingsHashRef.current) return;

    lastSettingsHashRef.current = hash;
    telesomSession
      .refreshBalance({ autoTransfer: autoTransferConfig })
      .catch(() => {});
  }, [sessionId, requiresOtp, isConnected, autoTransferConfig]);

  const startSignIn = useCallback(
    async (passwordValue) => {
      if (!loginIdentifier.trim() || !passwordValue.trim()) {
        setErrorMessage('Enter your phone number and password.');
        return false;
      }

      setBusy(true);
      setErrorMessage('');

      try {
        await telesomSession.createSession({
          loginIdentifier: loginIdentifier.trim(),
          loginPassword: passwordValue,
          currency,
          autoTransfer: autoTransferConfig,
        });
        return true;
      } catch (err) {
        setErrorMessage(err.message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [autoTransferConfig, currency, loginIdentifier]
  );

  const submitOtp = useCallback(
    async (code) => {
      if (!telesomSession.hasSession()) {
        setErrorMessage('Sign in again first.');
        return false;
      }

      if (!String(code || '').trim()) {
        setErrorMessage('Enter the SMS code.');
        return false;
      }

      setBusy(true);
      setErrorMessage('');

      try {
        await telesomSession.submitAuthenticationCode(code.trim(), autoTransferConfig);
        return true;
      } catch (err) {
        setErrorMessage(err.message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [autoTransferConfig]
  );

  const signOut = useCallback(async () => {
    telesomSession.destroySession();
    setPin('');
    setPassword('');
    lastSettingsHashRef.current = '';
  }, []);

  // Used by the OTP screen's "Back" button — drops the pending Telesom
  // session so the user can retype phone/password, but keeps PIN and
  // password in the form so they don't have to retype everything.
  const cancelSignIn = useCallback(() => {
    telesomSession.destroySession();
    lastSettingsHashRef.current = '';
  }, []);

  const transferFunds = useCallback(
    async ({ recipientNumber: to, amountUsd, description, transactionPin }) => {
      if (!telesomSession.hasSession()) {
        throw new Error('Sign in before sending money.');
      }

      const cleanPin = String(transactionPin || pin || '').replace(/\D/g, '');
      if (!cleanPin || cleanPin.length < 4) {
        throw new Error('Enter your 4-digit MyMerchant PIN.');
      }

      setBusy(true);
      setErrorMessage('');

      try {
        const result = await telesomSession.transfer({
          recipientNumber: to,
          amountUsd,
          description,
          transactionPin: cleanPin,
          confirmTransfer: true,
        });
        return result;
      } catch (err) {
        setErrorMessage(err.message);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [pin]
  );

  const loadTransactions = useCallback(async () => {
    if (!telesomSession.hasSession()) return [];
    return telesomSession.getRecentTransactions();
  }, []);

  const loadActivityReport = useCallback(async ({ startDate, endDate }) => {
    if (!telesomSession.hasSession()) return [];
    return telesomSession.getActivityReport({ startDate, endDate });
  }, []);

  const value = useMemo(
    () => ({
      hydrated,
      loginIdentifier,
      setLoginIdentifier,
      recipientNumber,
      setRecipientNumber,
      triggerBalance,
      currency,
      setCurrency,
      pin,
      setPin,
      password,
      setPassword,
      sessionId,
      snapshot,
      busy,
      errorMessage,
      requiresOtp,
      sessionExpired,
      isConnected,
      isSignedIn,
      balanceUsd,
      accountHolderName,
      accountLabel,
      recentEvents,
      autoTransferState,
      startSignIn,
      submitOtp,
      signOut,
      cancelSignIn,
      transferFunds,
      loadTransactions,
      loadActivityReport,
    }),
    [
      accountHolderName,
      accountLabel,
      autoTransferState,
      balanceUsd,
      busy,
      cancelSignIn,
      currency,
      errorMessage,
      hydrated,
      isConnected,
      isSignedIn,
      loadActivityReport,
      loadTransactions,
      loginIdentifier,
      password,
      pin,
      recentEvents,
      recipientNumber,
      requiresOtp,
      sessionExpired,
      sessionId,
      signOut,
      snapshot,
      startSignIn,
      submitOtp,
      transferFunds,
      triggerBalance,
    ]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

export const useSession = () => {
  const ctx = useContext(SessionContext);

  if (!ctx) {
    throw new Error('useSession must be used inside <SessionProvider>');
  }

  return ctx;
};
