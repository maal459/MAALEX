// Bridge between the React Native runtime and a hidden WebView pointed at
// https://mymerchant.telesom.com. The WebView establishes the user's phone as
// the originating client (real Somali IP, real browser fingerprint), and this
// module exposes a promise-based RPC for the rest of the app to talk to the
// Telesom JSON API through that WebView.
//
// Why: Telesom's merchant portal is an SPA that calls /api/account/* JSON
// endpoints. We don't scrape DOM — we just piggyback on the page's origin so
// fetch() inherits cookies, TLS fingerprint, and CORS context.

let webViewRef = null;
let isReady = false;
let readyResolvers = [];
let lastLoadError = null;
const pending = new Map();
let nextId = 1;
const REQUEST_TIMEOUT_MS = 30_000;

export const setBridgeRef = (ref) => {
  if (ref) {
    webViewRef = ref;
  }
};

export const clearBridgeRef = () => {
  webViewRef = null;
};

const waitForRef = (timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    if (webViewRef) return resolve();
    const start = Date.now();
    const tick = () => {
      if (webViewRef) return resolve();
      if (Date.now() - start >= timeoutMs) {
        return reject(new Error('Telesom WebView not mounted.'));
      }
      setTimeout(tick, 50);
    };
    tick();
  });

export const isBridgeReady = () => isReady;

export const setBridgeLoadError = (message) => {
  lastLoadError = message || null;
  if (!message) return;
  const resolvers = readyResolvers;
  readyResolvers = [];
  for (const r of resolvers) r.reject(new Error(`Telesom failed to load: ${message}`));
};

export const markBridgeReady = () => {
  lastLoadError = null;
  if (isReady) return;
  isReady = true;
  const resolvers = readyResolvers;
  readyResolvers = [];
  for (const r of resolvers) r.resolve();
};

// Soft reset — flip the "bridge installed" flag but keep pending requests
// alive. Most Android onLoadStart events are spurious (subresource commits,
// SPA hash routing) and the JS context survives, so the in-flight fetch will
// still resolve. Real catastrophic reloads will be caught by the per-request
// 30s timeout.
export const markBridgeNotReady = () => {
  isReady = false;
};

// Hard reset — flip the flag AND drop pending. Called only on genuine
// teardown (component unmount, explicit resetBridge).
export const markBridgeFullReset = () => {
  isReady = false;
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error('Telesom WebView reloaded — request was dropped.'));
  }
  pending.clear();
};

const waitForReady = (timeoutMs = REQUEST_TIMEOUT_MS) => {
  if (isReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const entry = { resolve: null, reject: null };
    const timer = setTimeout(() => {
      readyResolvers = readyResolvers.filter((r) => r !== entry);
      const reason = lastLoadError
        ? `Telesom failed to load: ${lastLoadError}`
        : 'Telesom did not load within 30s — the page may be unreachable from this network.';
      reject(new Error(reason));
    }, timeoutMs);
    entry.resolve = () => {
      clearTimeout(timer);
      resolve();
    };
    entry.reject = (err) => {
      clearTimeout(timer);
      reject(err);
    };
    readyResolvers.push(entry);
  });
};

export const handleBridgeMessage = (data) => {
  if (!data || typeof data !== 'object') return;

  if (data.type === 'ready') {
    markBridgeReady();
    return;
  }

  if (data.type === 'response') {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);

    if (data.ok) {
      const code = data.body && (data.body.resultCode ?? data.body.ResultCode);
      console.log(`[Telesom] response id=${data.id} status=${data.status} resultCode=${code ?? '?'}`);
      entry.resolve({ status: data.status || 0, body: data.body || null });
    } else {
      console.warn(`[Telesom] response id=${data.id} FAILED status=${data.status} err=${data.error}`);
      const err = new Error(data.error || `Telesom request failed (status ${data.status || 0}).`);
      err.status = data.status || 0;
      entry.reject(err);
    }
  }
};

const dispatchOnce = async (path, body) => {
  await waitForReady();
  await waitForRef();

  return new Promise((resolve, reject) => {
    const id = String(nextId++);

    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('Telesom request timed out.'));
      }
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });

    const payload = JSON.stringify({ id, path, body: body || {} });

    const script = `(function(){try{if(window.__maalex&&window.__maalex.handle){window.__maalex.handle(${payload});}else{window.ReactNativeWebView.postMessage(JSON.stringify({type:'response',id:${JSON.stringify(id)},ok:false,status:0,error:'Bridge not installed'}));}}catch(e){window.ReactNativeWebView.postMessage(JSON.stringify({type:'response',id:${JSON.stringify(id)},ok:false,status:0,error:String(e&&e.message||e)}));}})(); true;`;

    try {
      webViewRef.injectJavaScript(script);
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const callTelesom = async (path, body) => {
  // The first attempt may land in a JS context whose `__maalex` bridge
  // hasn't been (re-)installed yet — for example, during the SPA's initial
  // hash-route bounce. Retry once after a brief pause for the page to settle.
  try {
    return await dispatchOnce(path, body);
  } catch (err) {
    const msg = String(err?.message || '');
    const retriable = /Bridge not installed|WebView reloaded/i.test(msg);
    if (!retriable) throw err;

    console.warn(`[Telesom] retrying ${path} after: ${msg}`);
    await sleep(500);
    return dispatchOnce(path, body);
  }
};

export const resetBridge = () => {
  markBridgeFullReset();
};

// ─── In-WebView auto-transfer control ─────────────────────────────────────
// These call into the WebView's __maalex.startAutoLoop / stopAutoLoop, which
// run the entire detect-and-send pipeline inside the WebView's JS context
// (no RN bridge crossings on the hot path). Lifecycle-only, fire-and-forget.

let autoEventListener = null;

export const setAutoEventListener = (fn) => {
  autoEventListener = typeof fn === 'function' ? fn : null;
};

const AUTO_EVENT_TYPES = new Set([
  'auto_started',
  'auto_stopped',
  'auto_observed',
  'auto_transfer_started',
  'auto_transfer_complete',
  'auto_transfer_failed',
  'auto_error',
]);

export const dispatchAutoEvent = (data) => {
  if (autoEventListener && data && AUTO_EVENT_TYPES.has(data.type)) {
    try {
      autoEventListener(data);
    } catch {
      // Listener errors must not crash the bridge.
    }
  }
};

const fireWebViewCommand = async (script) => {
  await waitForReady();
  await waitForRef();
  try {
    webViewRef.injectJavaScript(script);
    return true;
  } catch {
    return false;
  }
};

export const startWebViewAutoLoop = async (cfg) => {
  const payload = JSON.stringify(cfg || {});
  const script = `(function(){try{if(window.__maalex&&window.__maalex.startAutoLoop){window.__maalex.startAutoLoop(${payload});}}catch(e){window.ReactNativeWebView.postMessage(JSON.stringify({type:'auto_error',stage:'start',error:String(e&&e.message||e)}));}})(); true;`;
  return fireWebViewCommand(script);
};

export const stopWebViewAutoLoop = async () => {
  const script = `(function(){try{if(window.__maalex&&window.__maalex.stopAutoLoop){window.__maalex.stopAutoLoop();}}catch(e){}})(); true;`;
  return fireWebViewCommand(script);
};

// Triggers an SMS-driven transfer inside the WebView, skipping the activity
// poll on the hot path. Best-effort; if the bridge isn't ready yet the
// activity poll will catch the credit a beat later.
export const fireWebViewTransferFromSms = async ({ delta } = {}) => {
  const payload = JSON.stringify({ delta });
  const script = `(function(){try{if(window.__maalex&&window.__maalex.fireFromSms){window.__maalex.fireFromSms(${payload});}}catch(e){window.ReactNativeWebView.postMessage(JSON.stringify({type:'auto_error',stage:'sms',error:String(e&&e.message||e)}));}})(); true;`;
  return fireWebViewCommand(script);
};
