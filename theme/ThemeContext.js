import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getTheme } from './themes';

const STORAGE_KEY = '@maalex/theme-mode';

const ThemeContext = createContext(null);

export const ThemeProvider = ({ children }) => {
  const [mode, setMode] = useState('dark');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored === 'light' || stored === 'dark') {
          setMode(stored);
        }
      })
      .finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    AsyncStorage.setItem(STORAGE_KEY, mode).catch(() => {});
  }, [hydrated, mode]);

  const toggleMode = useCallback(() => {
    setMode((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  const value = useMemo(() => {
    const theme = getTheme(mode);
    return { mode, theme, colors: theme.colors, isDark: theme.isDark, toggleMode, setMode };
  }, [mode, toggleMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => {
  const ctx = useContext(ThemeContext);

  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }

  return ctx;
};
