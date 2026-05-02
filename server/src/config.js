import 'dotenv/config';

const numberFromEnv = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: numberFromEnv(process.env.PORT, 4000),
  sessionTtlMs: numberFromEnv(process.env.SESSION_TTL_MINUTES, 30) * 60 * 1000,
  allowedOrigin: process.env.ALLOWED_ORIGIN || '*',
};
