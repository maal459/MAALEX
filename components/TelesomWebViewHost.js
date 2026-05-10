import React, { useCallback, useEffect, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import {
  clearBridgeRef,
  dispatchAutoEvent,
  handleBridgeMessage,
  markBridgeFullReset,
  markBridgeNotReady,
  setBridgeLoadError,
  setBridgeRef,
} from '../services/telesomBridge';

const TELESOM_ORIGIN = 'https://mymerchant.telesom.com';

// Installed before the SPA boots so the bridge is available regardless of
// whether the page renders. Same-origin fetch picks up the WebView's cookies
// and TLS context automatically.
const BRIDGE_SCRIPT = `
(function() {
  var post = function(payload) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(payload)); } catch (e) {}
  };

  // Already installed in this JS context (hash/SPA navigation): the fetch
  // handler is still alive, just re-signal ready so waitForReady() unblocks.
  if (window.__maalex) {
    post({ type: 'ready' });
    return;
  }

  ['log','warn','error'].forEach(function(level) {
    var orig = console[level];
    console[level] = function() {
      try {
        var args = Array.prototype.slice.call(arguments).map(function(a) {
          try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
        });
        post({ type: 'log', level: level, message: args.join(' ') });
      } catch (e) {}
      return orig.apply(console, arguments);
    };
  });

  window.addEventListener('error', function(e) {
    post({ type: 'log', level: 'error', message: 'window.error: ' + (e && e.message || String(e)) });
  });

  var TELESOM_ORIGIN = 'https://mymerchant.telesom.com';

  post({ type: 'log', level: 'log', message: 'bridge installed at ' + window.location.href });

  var doFetch = function(path, body) {
    var url = (path && path.indexOf('http') === 0) ? path : (TELESOM_ORIGIN + path);
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      mode: 'cors',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(body || {})
    }).then(function(r) { return r.text().then(function(t) {
      var data = null;
      try { data = t ? JSON.parse(t) : null; } catch (e) {}
      return { status: r.status, body: data };
    }); });
  };

  window.__maalex = {
    handle: function(req) {
      var id = req && req.id;
      var path = req && req.path;
      var body = (req && req.body) || {};
      var url = (path && path.indexOf('http') === 0) ? path : (TELESOM_ORIGIN + path);

      post({ type: 'log', level: 'log', message: '-> POST ' + url + ' (id=' + id + ')' });

      try {
        doFetch(path, body).then(function(res) {
          if (!res.body) {
            post({ type: 'response', id: id, ok: false, status: res.status, error: 'Telesom returned non-JSON (status ' + res.status + ')' });
            return;
          }
          post({ type: 'response', id: id, ok: true, status: res.status, body: res.body });
        }).catch(function(err) {
          var msg = String(err && err.message || err);
          post({ type: 'log', level: 'error', message: 'fetch failed for ' + url + ': ' + msg });
          post({ type: 'response', id: id, ok: false, status: 0, error: 'Network error reaching Telesom (' + url + '): ' + msg });
        });
      } catch (e) {
        post({ type: 'response', id: id, ok: false, status: 0, error: String(e && e.message || e) });
      }
    },

    // ─── In-WebView auto-transfer loop ──────────────────────────────────────
    // Detection AND transfer both run in the WebView's JS context. The RN
    // bridge is only used to post lifecycle events back. Critical path:
    //   mini-statement RTT  →  p2p RTT
    // Nothing else.
    autoLoop: {
      cfg: null,
      lastTxId: null,
      lastEmittedBalance: null,
      lastEmittedTxId: null,
      baselineBalance: 0,
      lastChangeAt: 0,
      inFlight: false,
      timer: null,
      ACTIVE_MS: 40,
      IDLE_MS: 200,
      ACTIVE_WINDOW_MS: 60000,
      ERROR_BACKOFF_MS: 800,

      start: function(cfg) {
        this.cfg = cfg;
        this.lastTxId = null;
        this.lastEmittedBalance = null;
        this.lastEmittedTxId = null;
        this.lastChangeAt = Date.now();
        this.inFlight = false;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        post({ type: 'auto_started', cfg: { recipient: cfg.recipientMobile, threshold: cfg.threshold } });
        this.tick();
      },

      stop: function() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.cfg = null;
        post({ type: 'auto_stopped' });
      },

      schedule: function(ms) {
        var self = this;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(function() { self.tick(); }, Math.max(0, ms));
      },

      nextDelay: function() {
        var elapsed = Date.now() - this.lastChangeAt;
        return elapsed < this.ACTIVE_WINDOW_MS ? this.ACTIVE_MS : this.IDLE_MS;
      },

      ymd: function(d) {
        var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      },

      tick: function() {
        var self = this;
        if (!this.cfg) return;
        var cfg = this.cfg;
        var startedAt = Date.now();

        // 2-day rolling window so a midnight rollover never misses a tx.
        // /api/report/activity is the fastest signal we have: a new credit
        // row appears here before /api/account/balance updates, so the row's
        // CREDIT column is what we forward — not "balance - threshold".
        var now = new Date();
        var yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        doFetch('/api/report/activity', {
          userNature: 'MERCHANT',
          sessionId: cfg.sessionId,
          startDate: self.ymd(yesterday),
          endDate: self.ymd(now)
        }).then(function(res) {
          if (!self.cfg) return;
          var data = res.body || {};
          var rows = (data && data.activityReport) || [];

          var rescheduleNow = function() {
            var elapsed = Date.now() - startedAt;
            self.schedule(self.nextDelay() - elapsed);
          };

          if (rows.length === 0) {
            rescheduleNow();
            return;
          }

          // Oldest → newest; newest is the tail.
          var latest = rows[rows.length - 1];
          var latestId = String(latest.TRANSFERID || latest.TRANSACTIONID || '');
          var balanceRaw = latest.ACCOUNTBALANCE;
          if (balanceRaw === undefined || balanceRaw === null) balanceRaw = latest.BALANCE;
          var balance = parseFloat(String(balanceRaw).replace(/,/g, ''));
          if (!isFinite(balance)) balance = 0;

          // Live balance mirror for the UI.
          if (balance !== self.lastEmittedBalance || latestId !== self.lastEmittedTxId) {
            self.lastEmittedBalance = balance;
            self.lastEmittedTxId = latestId;
            post({
              type: 'auto_observed',
              latestId: latestId,
              balance: balance,
              changedTx: latestId !== self.lastTxId
            });
          }

          // Excess above threshold — this is what stays sitting in the
          // account beyond the keep-amount. Drained on first tick (so the
          // merchant doesn't have to wait for the next credit) and on every
          // new tx (in case the credit only partially exceeded threshold).
          var threshold = isFinite(cfg.threshold) ? cfg.threshold : 0;
          var excess = balance > threshold ? (balance - threshold) : 0;

          if (self.lastTxId === null) {
            self.lastTxId = latestId;
            self.baselineBalance = balance;
            if (excess > 0 && !self.inFlight) {
              self.lastChangeAt = Date.now();
              self.fireTransfer(excess);
            }
            rescheduleNow();
            return;
          }

          if (latestId !== self.lastTxId) {
            // Walk newest → oldest until we hit the last seen id, summing
            // every CREDIT row. Forward the larger of (sum of new credits)
            // and (current excess above threshold) so we both pass through
            // the new payment AND drain any leftover above the keep-amount.
            var creditedTotal = 0;
            for (var i = rows.length - 1; i >= 0; i--) {
              var row = rows[i];
              var id = String(row.TRANSFERID || row.TRANSACTIONID || '');
              if (id === self.lastTxId) break;
              var credit = parseFloat(String(row.CREDIT || 0).replace(/,/g, ''));
              if (isFinite(credit) && credit > 0) {
                creditedTotal += credit;
              }
            }
            self.lastTxId = latestId;
            self.lastChangeAt = Date.now();

            var forwardAmount = creditedTotal > excess ? creditedTotal : excess;
            if (forwardAmount > 0 && !self.inFlight) {
              self.fireTransfer(forwardAmount);
            }
          }

          rescheduleNow();
        }).catch(function(err) {
          post({ type: 'auto_error', stage: 'poll', error: String(err && err.message || err) });
          if (self.cfg) self.schedule(self.ERROR_BACKOFF_MS);
        });
      },

      // SMS fast-path: Zaad SMS arrives ~1s before /api/report/activity
      // reflects the credit. We trust the SMS amount and forward it
      // immediately. inFlight prevents racing with the activity poll.
      fireFromSms: function(args) {
        if (!this.cfg) return;
        if (this.inFlight) return;
        var delta = parseFloat(String((args && args.delta) || 0));
        if (!isFinite(delta) || delta <= 0) return;
        this.lastChangeAt = Date.now();
        this.fireTransfer(delta);
      },

      fireTransfer: function(amount) {
        var self = this;
        var cfg = this.cfg;
        if (!isFinite(amount) || amount <= 0) return;

        var amountStr = (amount === Math.floor(amount))
          ? String(Math.floor(amount))
          : amount.toFixed(2);

        self.inFlight = true;
        var startedAt = Date.now();
        post({ type: 'auto_transfer_started', amount: amountStr });

        doFetch('/api/money/b2p', {
          userNature: 'MERCHANT',
          sessionId: cfg.sessionId,
          receiverMobile: cfg.recipientMobile,
          receiverName: cfg.recipientName || '',
          amount: amountStr,
          pin: String(cfg.pin),
          description: cfg.description || '',
          isInterNetwork: cfg.isInterNetwork || '0'
        }).then(function(res) {
          self.inFlight = false;
          var data = res.body || {};
          var code = String(data.resultCode || '');
          var ok = code === '0' || code === '2001';
          var newBalance = (data.transferInfo && data.transferInfo.currentBalance) || '';
          if (ok && newBalance) {
            var nb = parseFloat(String(newBalance).replace(/,/g, ''));
            if (isFinite(nb)) self.baselineBalance = nb;
          }
          post({
            type: ok ? 'auto_transfer_complete' : 'auto_transfer_failed',
            amount: amountStr,
            recipient: cfg.recipientMobile,
            balance: newBalance,
            resultCode: code,
            replyMessage: data.replyMessage || '',
            elapsedMs: Date.now() - startedAt
          });
        }).catch(function(err) {
          self.inFlight = false;
          post({
            type: 'auto_transfer_failed',
            amount: amountStr,
            error: String(err && err.message || err),
            elapsedMs: Date.now() - startedAt
          });
        });
      }
    },

    startAutoLoop: function(cfg) { this.autoLoop.start(cfg); },
    stopAutoLoop: function() { this.autoLoop.stop(); },
    fireFromSms: function(args) { this.autoLoop.fireFromSms(args); }
  };

  post({ type: 'ready' });
})();
true;
`;

const MOBILE_USER_AGENT =
  Platform.OS === 'ios'
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
    : 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const baseUrl = (url) => (url || '').split('#')[0].split('?')[0];

const TelesomWebViewHost = () => {
  const ref = useRef(null);
  const lastBaseUrlRef = useRef('');

  useEffect(() => {
    return () => {
      clearBridgeRef();
      markBridgeFullReset();
    };
  }, []);

  const onMessage = useCallback((event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data && data.type === 'log') {
        console.log(`[TelesomWebView:${data.level}]`, data.message);
        return;
      }
      if (data && typeof data.type === 'string' && data.type.indexOf('auto_') === 0) {
        console.log(`[TelesomAuto:${data.type}]`, JSON.stringify(data));
        dispatchAutoEvent(data);
        return;
      }
      handleBridgeMessage(data);
    } catch {
      // Ignore non-JSON messages.
    }
  }, []);

  const onLoadStart = useCallback((event) => {
    const url = event?.nativeEvent?.url || '';
    console.log('[TelesomWebView:loadStart]', url);

    const base = baseUrl(url);
    const prev = lastBaseUrlRef.current;

    // Record the base URL immediately so that the very next loadStart can
    // detect a hash-only navigation even if onLoadEnd never fired for this one
    // (iOS skips onLoadEnd when the SPA navigates away before the first load
    // commits).
    lastBaseUrlRef.current = base;

    // Hash-only navigation (SPA routing): JS context is preserved, window.__maalex
    // stays installed. Don't reset.
    if (prev && base === prev) {
      console.log('[TelesomWebView:loadStart] hash-only nav, bridge kept ready');
      return;
    }

    markBridgeNotReady();
  }, []);

  const onNavigationStateChange = useCallback((navState) => {
    const u = navState?.url;
    if (!u) return;
    if (!u.startsWith('https://mymerchant.telesom.com') && !u.startsWith('about:')) {
      console.warn('[TelesomWebView] navigated off origin:', u);
      setBridgeLoadError(`navigated off origin: ${u}`);
    }
  }, []);

  // Re-inject on every real (non-hash) load. iOS does not fire onLoadEnd
  // for hash navigation, so we only reach here on full page commits.
  const onLoadEnd = useCallback((event) => {
    const url = event?.nativeEvent?.url || '';
    lastBaseUrlRef.current = baseUrl(url);
    console.log('[TelesomWebView:loadEnd]', url);

    if (ref.current) {
      setBridgeRef(ref.current);
      ref.current.injectJavaScript(BRIDGE_SCRIPT);
    }
  }, []);

  const onError = useCallback((event) => {
    const e = event?.nativeEvent || {};
    const msg = `${e.code || 'ERR'} ${e.description || 'unknown error'} (${e.url || TELESOM_ORIGIN})`;
    console.warn('[TelesomWebView:onError]', msg);
    setBridgeLoadError(msg);
  }, []);

  const onHttpError = useCallback((event) => {
    const e = event?.nativeEvent || {};
    const msg = `HTTP ${e.statusCode || '?'} ${e.description || ''} (${e.url || TELESOM_ORIGIN})`;
    console.warn('[TelesomWebView:onHttpError]', msg);
    setBridgeLoadError(msg);
  }, []);

  const onRenderProcessGone = useCallback((event) => {
    const e = event?.nativeEvent || {};
    const msg = `render process gone${e.didCrash ? ' (crashed)' : ''}`;
    console.warn('[TelesomWebView:onRenderProcessGone]', msg);
    setBridgeLoadError(msg);
  }, []);

  return (
    <View pointerEvents="none" style={styles.host}>
      <WebView
        ref={(r) => {
          if (r) {
            ref.current = r;
            setBridgeRef(r);
          }
        }}
        source={{ uri: `${TELESOM_ORIGIN}/` }}
        injectedJavaScriptBeforeContentLoaded={BRIDGE_SCRIPT}
        onMessage={onMessage}
        onLoadStart={onLoadStart}
        onLoadEnd={onLoadEnd}
        onError={onError}
        onHttpError={onHttpError}
        onRenderProcessGone={onRenderProcessGone}
        onNavigationStateChange={onNavigationStateChange}
        javaScriptEnabled
        domStorageEnabled
        thirdPartyCookiesEnabled
        sharedCookiesEnabled
        cacheEnabled
        originWhitelist={['https://*', 'http://*']}
        userAgent={MOBILE_USER_AGENT}
        setSupportMultipleWindows={false}
        androidLayerType="software"
      />
    </View>
  );
};

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    overflow: 'hidden',
  },
});

export default TelesomWebViewHost;
