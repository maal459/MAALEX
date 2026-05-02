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
import {
  closeZaadSession,
  getZaadSession,
  loginToZaad,
  refreshZaadBalance,
  submitZaadAuthenticationCode,
  transferZaadFunds,
} from '../services/zaadBackend';
import {
  ZAAD_AUTO_TRANSFER_DESCRIPTION,
  ZAAD_AUTO_TRANSFER_TARGET_NUMBER,
  ZAAD_AUTO_TRANSFER_TRIGGER_BALANCE_USD,
} from '../constants/appConfig';

const STORAGE_KEY = '@maalex/zaad-auto-transfer';
const POLL_INTERVAL_MS = 600;

const sanitize = (value) => String(value ?? '').replace(/\s+/g, '').trim();

const SessionContext = createContext(null);

export const SessionProvider = ({ children }) => {
  const [hydrated, setHydrated] = useState(false);
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [recipientNumber, setRecipientNumber] = useState(
    String(ZAAD_AUTO_TRANSFER_TARGET_NUMBER || '')
  );
  const [triggerBalance, setTriggerBalance] = useState(
    String(ZAAD_AUTO_TRANSFER_TRIGGER_BALANCE_USD ?? 600)
  );
  const [currency, setCurrency] = useState('840');
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const lastSettingsHashRef = useRef('');

  const requiresOtp = Boolean(snapshot?.requiresAuthenticationCode);
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
      triggerBalanceUsd: String(triggerBalance || ''),
      description: ZAAD_AUTO_TRANSFER_DESCRIPTION,
      pin: String(pin || '').replace(/\D/g, ''),
    }),
    [recipientNumber, triggerBalance, pin]
  );

  useEffect(() => {
    let cancelled = false;

    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (cancelled || !stored) {
          return;
        }

        try {
          const parsed = JSON.parse(stored);

          if (parsed.loginIdentifier) {
            setLoginIdentifier(parsed.loginIdentifier);
          }

          if (parsed.recipientNumber) {
            setRecipientNumber(parsed.recipientNumber);
          }

          if (parsed.triggerBalance) {
            setTriggerBalance(String(parsed.triggerBalance));
          }

          if (parsed.currency) {
            setCurrency(String(parsed.currency));
          }

          if (parsed.pin) {
            // Persisted on-device so auto-transfer can resume without the user
            // re-typing the PIN after every app launch. AsyncStorage on Android
            // is NOT encrypted by default — accept the tradeoff or migrate to
            // expo-secure-store later.
            setPin(String(parsed.pin));
          }

          if (parsed.password) {
            // Same security caveat as PIN. Stored so the merchant only
            // re-types the OTP after a session expires, not the password.
            setPassword(String(parsed.password));
          }

          if (parsed.sessionId) {
            setSessionId(parsed.sessionId);
          }
        } catch {
          // Ignore corrupted storage.
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        loginIdentifier,
        recipientNumber,
        triggerBalance,
        currency,
        pin,
        password,
        sessionId,
      })
    ).catch(() => {});
  }, [hydrated, loginIdentifier, recipientNumber, triggerBalance, currency, pin, password, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setSnapshot(null);
      return undefined;
    }

    let cancelled = false;
    let timer = null;

    const tick = async () => {
      if (cancelled) {
        return;
      }

      try {
        const next = await getZaadSession(sessionId);

        if (cancelled) {
          return;
        }

        if (!next || next.status === 'signed_out') {
          setSessionId('');
          setSnapshot(null);
          setErrorMessage('Session ended. Please sign in again.');
          return;
        }

        setSnapshot(next);
        setErrorMessage('');
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (error.status === 404) {
          setSessionId('');
          setSnapshot(null);
          setErrorMessage('Session ended. Please sign in again.');
          return;
        }

        setErrorMessage(error.message);
      } finally {
        if (!cancelled) {
          timer = setTimeout(tick, POLL_INTERVAL_MS);
        }
      }
    };

    tick();

    return () => {
      cancelled = true;

      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || requiresOtp || !isConnected) {
      return;
    }

    const hash = `${autoTransferConfig.recipientNumber}|${autoTransferConfig.triggerBalanceUsd}|${autoTransferConfig.pin ? '1' : '0'}`;

    if (hash === lastSettingsHashRef.current) {
      return;
    }

    lastSettingsHashRef.current = hash;
    refreshZaadBalance(sessionId, autoTransferConfig).catch(() => {});
  }, [sessionId, requiresOtp, isConnected, autoTransferConfig]);

  const startSignIn = useCallback(
    async (password) => {
      if (!loginIdentifier.trim() || !password.trim()) {
        setErrorMessage('Enter your phone number and password.');
        return false;
      }

      setBusy(true);
      setErrorMessage('');

      try {
        const session = await loginToZaad({
          loginIdentifier: loginIdentifier.trim(),
          loginPassword: password,
          currency,
          autoTransfer: autoTransferConfig,
        });
        setSessionId(session.sessionId);
        setSnapshot(session);
        return true;
      } catch (error) {
        setErrorMessage(error.message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [autoTransferConfig, currency, loginIdentifier]
  );

  const submitOtp = useCallback(
    async (code) => {
      if (!sessionId) {
        setErrorMessage('Sign in again first.');
        return false;
      }

      if (!code.trim()) {
        setErrorMessage('Enter the SMS code.');
        return false;
      }

      setBusy(true);
      setErrorMessage('');

      try {
        const session = await submitZaadAuthenticationCode({
          sessionId,
          authenticationCode: code.trim(),
          autoTransfer: autoTransferConfig,
        });
        setSnapshot(session);
        return true;
      } catch (error) {
        setErrorMessage(error.message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [autoTransferConfig, sessionId]
  );

  const signOut = useCallback(async () => {
    const id = sessionId;

    setSessionId('');
    setSnapshot(null);
    setPin('');
    setPassword('');
    lastSettingsHashRef.current = '';

    if (id) {
      try {
        await closeZaadSession(id);
      } catch {
        // Server may already have purged it.
      }
    }
  }, [sessionId]);

  const transferFunds = useCallback(
    async ({ recipientNumber: to, amountUsd, description, transactionPin }) => {
      if (!sessionId) {
        throw new Error('Sign in before sending money.');
      }

      const cleanPin = String(transactionPin || pin || '').replace(/\D/g, '');

      if (!cleanPin || cleanPin.length < 4) {
        throw new Error('Enter your 4-digit MyMerchant PIN.');
      }

      setBusy(true);
      setErrorMessage('');

      try {
        const session = await transferZaadFunds({
          sessionId,
          recipientNumber: to,
          amountUsd,
          description,
          transactionPin: cleanPin,
          confirmTransfer: true,
        });
        setSnapshot(session);
        return session;
      } catch (error) {
        setErrorMessage(error.message);
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [pin, sessionId]
  );

  const value = useMemo(
    () => ({
      hydrated,
      loginIdentifier,
      setLoginIdentifier,
      recipientNumber,
      setRecipientNumber,
      triggerBalance,
      setTriggerBalance,
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
      transferFunds,
    }),
    [
      accountHolderName,
      accountLabel,
      autoTransferState,
      balanceUsd,
      busy,
      currency,
      errorMessage,
      hydrated,
      isConnected,
      isSignedIn,
      loginIdentifier,
      password,
      pin,
      recentEvents,
      recipientNumber,
      requiresOtp,
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
