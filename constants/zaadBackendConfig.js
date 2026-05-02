const rawBaseUrl = String(process.env.EXPO_PUBLIC_ZAAD_BACKEND_URL || '').trim();

export const ZAAD_BACKEND_BASE_URL = rawBaseUrl.replace(/\/+$/, '');
export const isZaadBackendConfigured = () => Boolean(ZAAD_BACKEND_BASE_URL);
