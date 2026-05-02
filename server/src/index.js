import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { issueTrialLicense, licenseMiddleware, validateLicense } from './licenses.js';
import { HttpError, TelesomAutomationService } from './telesomService.js';

const app = express();
const service = new TelesomAutomationService();

app.use(
  cors({
    origin: config.allowedOrigin,
    allowedHeaders: ['Content-Type', 'x-maalex-license'],
  })
);
app.use(express.json({ limit: '1mb' }));
app.use(licenseMiddleware);

const asyncHandler = (handler) => async (request, response, next) => {
  try {
    await handler(request, response, next);
  } catch (error) {
    next(error);
  }
};

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'maalex-zaad-backend' });
});

app.post('/api/license/validate', (request, response) => {
  const submitted = request.body?.licenseKey ?? request.header('x-maalex-license');
  const deviceId = request.body?.deviceId ?? request.header('x-maalex-device');
  const result = validateLicense(submitted, { deviceId });

  console.log(
    `[license] validate keyPrefix=${String(submitted || '').slice(0, 12)}… deviceId=${deviceId ? deviceId.slice(0, 6) + '…' : 'none'} -> ok=${result.ok}${result.ok ? '' : ` reason="${result.reason}"`}`
  );

  if (!result.ok) {
    response.status(401).json({ error: result.reason });
    return;
  }

  response.json({ license: result.license });
});

const issuedTrials = new Map(); // deviceId -> issuedAt (lightweight in-memory throttle)
const TRIAL_THROTTLE_MS = 60 * 1000;

app.post('/api/license/trial', (request, response) => {
  const deviceId = String(
    request.body?.deviceId || request.header('x-maalex-device') || ''
  ).trim();

  if (!deviceId || deviceId.length < 8) {
    response.status(400).json({ error: 'A device identifier is required.' });
    return;
  }

  const lastIssued = issuedTrials.get(deviceId);
  if (lastIssued && Date.now() - lastIssued < TRIAL_THROTTLE_MS) {
    response.status(429).json({
      error: 'Slow down — wait a minute before requesting another trial.',
    });
    return;
  }

  try {
    const { key, payload } = issueTrialLicense(deviceId);
    issuedTrials.set(deviceId, Date.now());

    console.log(
      `[license] trial issued deviceId=${deviceId.slice(0, 6)}… expires=${new Date(payload.exp).toISOString()}`
    );

    response.json({
      license: {
        key,
        tier: 'trial',
        label: 'Free trial',
        expiresAt: new Date(payload.exp).toISOString(),
        issuedAt: new Date(payload.iat).toISOString(),
        deviceId,
      },
    });
  } catch (error) {
    response.status(400).json({ error: error.message || 'Could not issue trial.' });
  }
});

app.post(
  '/api/zaad/session/login',
  asyncHandler(async (request, response) => {
    const session = await service.createSession(request.body || {});
    response.status(201).json({ session });
  })
);

app.post(
  '/api/zaad/session/otp',
  asyncHandler(async (request, response) => {
    const session = await service.submitAuthenticationCode(
      request.body?.sessionId,
      request.body?.authenticationCode,
      request.body?.autoTransfer
    );
    response.json({ session });
  })
);

app.get(
  '/api/zaad/session/:sessionId',
  asyncHandler(async (request, response) => {
    const session = await service.getSessionSnapshot(request.params.sessionId);
    response.json({ session });
  })
);

app.post(
  '/api/zaad/session/:sessionId/balance',
  asyncHandler(async (request, response) => {
    const session = await service.refreshBalance(request.params.sessionId, request.body || {});
    response.json({ session });
  })
);

app.post(
  '/api/zaad/session/:sessionId/transfer',
  asyncHandler(async (request, response) => {
    const session = await service.transfer(request.params.sessionId, request.body || {});
    response.json({ session });
  })
);

app.get(
  '/api/zaad/session/:sessionId/transactions',
  asyncHandler(async (request, response) => {
    const transactions = await service.getRecentTransactions(request.params.sessionId);
    response.json({ transactions });
  })
);

app.delete(
  '/api/zaad/session/:sessionId',
  asyncHandler(async (request, response) => {
    await service.destroySession(request.params.sessionId);
    response.json({ ok: true });
  })
);

app.use((error, _request, response, _next) => {
  const status = error instanceof HttpError ? error.status : 500;
  const message =
    error instanceof HttpError ? error.message : 'The MAALEX backend failed while talking to MyMerchant.';

  response.status(status).json({
    error: message,
  });
});

const server = app.listen(config.port, () => {
  console.log(`MAALEX ZAAD backend listening on port ${config.port}`);
});

const shutdown = async () => {
  server.close(async () => {
    await service.shutdown().catch(() => {});
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
