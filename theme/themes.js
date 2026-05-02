export const darkTheme = {
  name: 'dark',
  isDark: true,
  colors: {
    background: '#0f172a',
    surface: '#1e293b',
    surfaceElevated: '#273449',
    border: '#334155',
    primary: '#22d3ee',
    primaryDark: '#0891b2',
    accent: '#a855f7',
    success: '#22c55e',
    warning: '#f59e0b',
    danger: '#ef4444',
    textPrimary: '#f8fafc',
    textSecondary: '#94a3b8',
    textMuted: '#64748b',
    onPrimary: '#0b1020',
    overlay: 'rgba(0,0,0,0.55)',
  },
};

export const lightTheme = {
  name: 'light',
  isDark: false,
  colors: {
    background: '#f8fafc',
    surface: '#ffffff',
    surfaceElevated: '#ffffff',
    border: '#e2e8f0',
    primary: '#0891b2',
    primaryDark: '#0e7490',
    accent: '#7c3aed',
    success: '#15803d',
    warning: '#b45309',
    danger: '#b91c1c',
    textPrimary: '#0f172a',
    textSecondary: '#475569',
    textMuted: '#94a3b8',
    onPrimary: '#ffffff',
    overlay: 'rgba(15,23,42,0.35)',
  },
};

export const getTheme = (name) => (name === 'light' ? lightTheme : darkTheme);
