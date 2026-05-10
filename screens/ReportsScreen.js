import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

const LIVE_REFRESH_INTERVAL_MS = 5_000;
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { useSession } from '../context/SessionContext';

// ----- helpers -----

// Telesom activityReport returns TRANSFERDATE as "YYYY/M/D H:M:S".
// Also tolerate ISO and the older dd/mm/yyyy hh:mm[:ss] mini-statement shape.
const parseTxDate = (raw) => {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  const iso = Date.parse(value);
  if (Number.isFinite(iso)) return new Date(iso);

  // yyyy/m/d [h:m[:s]]
  const slashYmd = value.match(
    /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[\sT](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/
  );
  if (slashYmd) {
    const [, yyyy, mm, dd, hh = '0', mi = '0', ss = '0'] = slashYmd;
    const d = new Date(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(mi),
      Number(ss)
    );
    if (!Number.isNaN(d.getTime())) return d;
  }

  // dd/mm/yyyy [hh:mm[:ss]]
  const slashDmy = value.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\sT](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (slashDmy) {
    const [, dd, mm, yyyy, hh = '0', mi = '0', ss = '0'] = slashDmy;
    const d = new Date(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(mi),
      Number(ss)
    );
    if (!Number.isNaN(d.getTime())) return d;
  }

  // yyyy-mm-dd hh:mm:ss
  const dash = value.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[\sT](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (dash) {
    const [, yyyy, mm, dd, hh = '0', mi = '0', ss = '0'] = dash;
    const d = new Date(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(mi),
      Number(ss)
    );
    if (!Number.isNaN(d.getTime())) return d;
  }

  return null;
};

const parseAmount = (raw) => {
  if (raw === null || raw === undefined) return 0;
  const cleaned = String(raw).replace(/[^\d.\-]/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
};

// "NAME (252634400247) " → { name, msisdn }
const parseCounterparty = (raw) => {
  const value = String(raw || '').trim();
  if (!value) return { name: '', msisdn: '' };
  const m = value.match(/^(.*?)\s*\((\d+)\)\s*$/);
  if (m) return { name: m[1].trim(), msisdn: m[2] };
  return { name: value, msisdn: '' };
};

const ymd = (d) => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const startOfWeek = (d) => {
  // Week starts Monday
  const x = startOfDay(d);
  const day = x.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return x;
};

const startOfMonth = (d) => {
  const x = new Date(d);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
};

const PERIODS = [
  {
    key: 'day',
    label: 'Today',
    sublabel: '24 hrs',
    icon: 'today-outline',
    startFn: startOfDay,
  },
  {
    key: 'week',
    label: 'This week',
    sublabel: '7 days',
    icon: 'calendar-outline',
    startFn: startOfWeek,
  },
  {
    key: 'month',
    label: 'This month',
    sublabel: 'MTD',
    icon: 'calendar-number-outline',
    startFn: startOfMonth,
  },
  {
    key: 'all',
    label: 'Last 90 days',
    sublabel: 'Quarter',
    icon: 'time-outline',
    startFn: (d) => {
      const x = startOfDay(d);
      x.setDate(x.getDate() - 89);
      return x;
    },
  },
];

const formatMoney = (n) => {
  if (!Number.isFinite(n)) return '0.00';
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

// ----- component -----

const ReportsScreen = () => {
  const { colors } = useTheme();
  const { sessionId, isSignedIn, recentEvents, loadActivityReport } = useSession();
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [hasLoaded, setHasLoaded] = useState(false);
  const [period, setPeriod] = useState('day');
  const [lastLiveAt, setLastLiveAt] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const inFlightRef = useRef(false);

  const load = useCallback(
    async (mode = 'initial') => {
      if (!sessionId || !isSignedIn) return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;

      if (mode === 'refresh') setRefreshing(true);
      else if (mode === 'initial') setLoading(true);

      if (mode !== 'live') setError('');

      try {
        const def = PERIODS.find((p) => p.key === period) || PERIODS[0];
        const now = new Date();
        const startDate = ymd(def.startFn(now));
        const endDate = ymd(now);
        const rows = await loadActivityReport({ startDate, endDate });
        setTransactions(rows);
        setHasLoaded(true);
        if (mode === 'live') setLastLiveAt(new Date());
      } catch (err) {
        if (mode !== 'live') {
          setError(err.message || 'Could not load activity report.');
        }
      } finally {
        inFlightRef.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [isSignedIn, loadActivityReport, period, sessionId]
  );

  // Auto-load on first sign-in, and whenever the period changes.
  useEffect(() => {
    if (isSignedIn && sessionId) {
      load('initial');
    }
  }, [isSignedIn, load, sessionId, period]);

  // Live polling — keep MyMerchant transactions fresh while signed in.
  useEffect(() => {
    if (!isSignedIn || !sessionId) return undefined;

    const timer = setInterval(() => {
      load('live');
    }, LIVE_REFRESH_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [isSignedIn, load, sessionId]);

  const enriched = useMemo(
    () =>
      (transactions || []).map((tx) => {
        const cp = parseCounterparty(tx.counterparty);
        return {
          ...tx,
          _dir: tx.direction || (tx.credit > 0 ? 'in' : tx.debit > 0 ? 'out' : 'unknown'),
          _amt: parseAmount(tx.amount) || tx.credit || tx.debit || 0,
          _date: parseTxDate(tx.date),
          _cpName: cp.name,
          _cpMsisdn: cp.msisdn,
        };
      }),
    [transactions]
  );

  // Customer-trust view: hide incoming credits entirely. Customers watching
  // the merchant's report should see the merchant as a clean passthrough —
  // money only ever leaves, going to the configured destination.
  const filtered = useMemo(() => {
    return [...enriched]
      .filter((tx) => tx._dir !== 'in')
      .sort((a, b) => {
        const ta = a._date ? a._date.getTime() : 0;
        const tb = b._date ? b._date.getTime() : 0;
        return tb - ta;
      });
  }, [enriched]);

  const summary = useMemo(() => {
    let outflow = 0;
    let outCount = 0;

    for (const tx of filtered) {
      if (tx._dir === 'out') {
        outflow += tx._amt;
        outCount += 1;
      }
    }

    // Net == total sent (no inflow subtracted, since received is hidden).
    return {
      count: outCount,
      outflow,
      net: outflow,
      outCount,
    };
  }, [filtered]);

  if (!isSignedIn) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
        <View style={styles.empty}>
          <Ionicons name="document-text-outline" size={48} color={colors.textMuted} />
          <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>Not signed in</Text>
          <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
            Sign in on the Setup tab to load transaction reports.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const events = recentEvents || [];

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load('refresh')}
            tintColor={colors.primary}
          />
        }
      >
        <View style={styles.headerRow}>
          <Text style={[styles.heading, { color: colors.textPrimary }]}>Reports</Text>
          <View style={styles.headerActions}>
            <View style={styles.liveBadge}>
              <View style={[styles.liveDot, { backgroundColor: colors.success }]} />
              <Text style={[styles.liveText, { color: colors.textSecondary }]}>
                {lastLiveAt ? `Live · ${lastLiveAt.toLocaleTimeString()}` : 'Live'}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => load('initial')}
              style={[styles.refreshBtn, { borderColor: colors.border }]}
            >
              <Ionicons name="refresh" size={18} color={colors.primary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* period selector — card-style chips with icons */}
        <View style={styles.periodRow}>
          {PERIODS.map((p) => {
            const active = p.key === period;
            return (
              <TouchableOpacity
                key={p.key}
                onPress={() => setPeriod(p.key)}
                activeOpacity={0.85}
                style={[
                  styles.periodCard,
                  {
                    backgroundColor: active ? colors.primary : colors.surface,
                    borderColor: active ? colors.primary : colors.border,
                  },
                ]}
              >
                <View
                  style={[
                    styles.periodIconWrap,
                    {
                      backgroundColor: active
                        ? 'rgba(255,255,255,0.18)'
                        : colors.background,
                    },
                  ]}
                >
                  <Ionicons
                    name={p.icon}
                    size={18}
                    color={active ? colors.onPrimary : colors.primary}
                  />
                </View>
                <Text
                  style={[
                    styles.periodLabel,
                    { color: active ? colors.onPrimary : colors.textPrimary },
                  ]}
                  numberOfLines={1}
                >
                  {p.label}
                </Text>
                <Text
                  style={[
                    styles.periodSublabel,
                    {
                      color: active
                        ? 'rgba(255,255,255,0.82)'
                        : colors.textMuted,
                    },
                  ]}
                  numberOfLines={1}
                >
                  {p.sublabel}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* summary card */}
        <View
          style={[
            styles.summaryCard,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}
        >
          <View style={styles.summaryHeaderRow}>
            <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>
              {(PERIODS.find((p) => p.key === period) || PERIODS[0]).label}
            </Text>
            <Text style={[styles.summaryCount, { color: colors.textMuted }]}>
              {summary.count} {summary.count === 1 ? 'transaction' : 'transactions'}
            </Text>
          </View>

          <View style={styles.summaryNetRow}>
            <Text style={[styles.summaryNetLabel, { color: colors.textSecondary }]}>Net sent</Text>
            <Text style={[styles.summaryNetValue, { color: colors.textPrimary }]}>
              ${formatMoney(summary.net)}
            </Text>
          </View>

          <View style={[styles.summarySplit, { borderTopColor: colors.border }]}>
            <View style={styles.summaryStat}>
              <View style={styles.summaryStatHead}>
                <Ionicons name="arrow-up" size={14} color={colors.primary} />
                <Text style={[styles.summaryStatLabel, { color: colors.textSecondary }]}>
                  Total sent
                </Text>
              </View>
              <Text style={[styles.summaryStatValue, { color: colors.textPrimary }]}>
                ${formatMoney(summary.outflow)}
              </Text>
              <Text style={[styles.summaryStatCount, { color: colors.textMuted }]}>
                {summary.outCount} {summary.outCount === 1 ? 'transfer' : 'transfers'}
              </Text>
            </View>
          </View>
        </View>

        {/* errors / empty / loading */}
        {error ? (
          <View
            style={[
              styles.errorBox,
              { borderColor: colors.danger, backgroundColor: 'rgba(239, 68, 68, 0.08)' },
            ]}
          >
            <Text style={[styles.errorText, { color: colors.danger }]}>{error}</Text>
          </View>
        ) : null}

        {loading && !hasLoaded ? (
          <View style={styles.loaderRow}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : null}

        {/* app activity */}
        <Text style={[styles.subheading, { color: colors.textSecondary, marginTop: 18 }]}>
          App activity
        </Text>
        {events.length === 0 ? (
          <View
            style={[
              styles.empty,
              { backgroundColor: colors.surface, borderColor: colors.border, paddingVertical: 18 },
            ]}
          >
            <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
              No automation activity yet.
            </Text>
          </View>
        ) : (
          [...events]
            .reverse()
            .slice(0, 10)
            .map((event) => (
              <View
                key={event.id}
                style={[
                  styles.eventRow,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                ]}
              >
                <Ionicons
                  name={
                    event.type === 'auto_transfer'
                      ? 'arrow-up-circle'
                      : event.type === 'balance_increase'
                      ? 'arrow-down-circle'
                      : 'pause-circle'
                  }
                  size={22}
                  color={
                    event.type === 'auto_transfer'
                      ? colors.primary
                      : event.type === 'balance_increase'
                      ? colors.success
                      : colors.warning
                  }
                />
                <View style={styles.eventBody}>
                  <Text style={[styles.eventMessage, { color: colors.textPrimary }]}>
                    {event.message}
                  </Text>
                  <Text style={[styles.eventTime, { color: colors.textMuted }]}>
                    {event.at ? new Date(event.at).toLocaleString() : ''}
                  </Text>
                </View>
              </View>
            ))
        )}

        {/* MyMerchant activity report for the chosen period */}
        <Text style={[styles.subheading, { color: colors.textSecondary, marginTop: 18 }]}>
          MyMerchant activity
        </Text>

        {hasLoaded && filtered.length === 0 && !error ? (
          <View
            style={[
              styles.empty,
              { backgroundColor: colors.surface, borderColor: colors.border, paddingVertical: 24 },
            ]}
          >
            <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
              No transactions in this period.
            </Text>
          </View>
        ) : null}

        {filtered.map((tx) => {
          const tone =
            tx._dir === 'in'
              ? colors.success
              : tx._dir === 'out'
              ? colors.danger
              : colors.textSecondary;
          const arrow =
            tx._dir === 'in'
              ? 'arrow-down'
              : tx._dir === 'out'
              ? 'arrow-up'
              : 'swap-horizontal';
          const expanded = expandedId === tx.id;
          const sign = tx._dir === 'in' ? '+' : tx._dir === 'out' ? '−' : '';

          return (
            <TouchableOpacity
              key={tx.id}
              activeOpacity={0.85}
              onPress={() => setExpandedId(expanded ? null : tx.id)}
              style={[
                styles.txRow,
                {
                  backgroundColor: colors.surface,
                  borderColor: expanded ? colors.primary : colors.border,
                },
              ]}
            >
              <View style={styles.txTopRow}>
                <View style={[styles.txIcon, { backgroundColor: tone + '22' }]}>
                  <Ionicons name={arrow} size={18} color={tone} />
                </View>
                <View style={styles.txBody}>
                  <Text style={[styles.txCounterparty, { color: colors.textPrimary }]} numberOfLines={1}>
                    {tx._cpName || tx.description || 'Transaction'}
                  </Text>
                  <Text style={[styles.txDate, { color: colors.textMuted }]} numberOfLines={1}>
                    {tx._cpMsisdn ? `${tx._cpMsisdn} · ` : ''}
                    {tx._date ? tx._date.toLocaleString() : tx.date || ''}
                  </Text>
                  {tx.description && !expanded ? (
                    <Text
                      style={[styles.txDescription, { color: colors.textSecondary }]}
                      numberOfLines={1}
                    >
                      {tx.description}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.txAmountColumn}>
                  <Text style={[styles.txAmount, { color: tone }]}>
                    {tx._amt ? `${sign}$${formatMoney(tx._amt)}` : '—'}
                  </Text>
                  {tx.accountBalance ? (
                    <Text style={[styles.txBalance, { color: colors.textMuted }]}>
                      bal ${tx.accountBalance}
                    </Text>
                  ) : null}
                  <Ionicons
                    name={expanded ? 'chevron-up' : 'chevron-down'}
                    size={14}
                    color={colors.textMuted}
                    style={{ marginTop: 4 }}
                  />
                </View>
              </View>

              {expanded ? (
                <View
                  style={[
                    styles.txExpand,
                    { borderTopColor: colors.border },
                  ]}
                >
                  {tx.description ? (
                    <View style={styles.expandRow}>
                      <Ionicons name="document-text-outline" size={14} color={colors.textMuted} />
                      <Text
                        style={[styles.expandText, { color: colors.textPrimary }]}
                        selectable
                      >
                        {tx.description}
                      </Text>
                    </View>
                  ) : null}

                  {tx._cpName ? (
                    <View style={styles.expandRow}>
                      <Ionicons name="person-outline" size={14} color={colors.textMuted} />
                      <Text style={[styles.expandText, { color: colors.textSecondary }]} selectable>
                        {tx._cpName}
                        {tx._cpMsisdn ? `  ·  ${tx._cpMsisdn}` : ''}
                      </Text>
                    </View>
                  ) : null}

                  {tx.transferId ? (
                    <View style={styles.expandRow}>
                      <Ionicons name="receipt-outline" size={14} color={colors.textMuted} />
                      <Text
                        style={[styles.expandText, { color: colors.textSecondary }]}
                        selectable
                      >
                        Ref: {tx.transferId}
                      </Text>
                    </View>
                  ) : null}

                  {tx.balanceAfter ? (
                    <View style={styles.expandRow}>
                      <Ionicons name="trending-up-outline" size={14} color={colors.textMuted} />
                      <Text style={[styles.expandText, { color: colors.textSecondary }]}>
                        Running balance: ${tx.balanceAfter}
                      </Text>
                    </View>
                  ) : null}

                  {tx.accountTitle ? (
                    <View style={styles.expandRow}>
                      <Ionicons name="wallet-outline" size={14} color={colors.textMuted} />
                      <Text style={[styles.expandText, { color: colors.textSecondary }]}>
                        {tx.accountTitle}
                      </Text>
                    </View>
                  ) : null}

                  {tx._date ? (
                    <View style={styles.expandRow}>
                      <Ionicons name="time-outline" size={14} color={colors.textMuted} />
                      <Text style={[styles.expandText, { color: colors.textSecondary }]}>
                        {tx._date.toLocaleString()}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { padding: 20, paddingBottom: 40 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  heading: { fontFamily: 'bold', fontSize: 24 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  liveText: { fontFamily: 'medium', fontSize: 11 },
  refreshBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  periodRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
    marginBottom: 14,
  },
  periodCard: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 6,
    borderRadius: 14,
    alignItems: 'center',
    borderWidth: 1,
  },
  periodIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  periodLabel: {
    fontFamily: 'semiBold',
    fontSize: 11,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  periodSublabel: {
    fontFamily: 'medium',
    fontSize: 9,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  summaryCard: {
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    marginBottom: 6,
  },
  summaryHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryLabel: {
    fontFamily: 'medium',
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  summaryCount: { fontFamily: 'medium', fontSize: 11 },
  summaryNetRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: 6,
    marginBottom: 14,
  },
  summaryNetLabel: { fontFamily: 'medium', fontSize: 13 },
  summaryNetValue: { fontFamily: 'bold', fontSize: 28 },
  summarySplit: {
    flexDirection: 'row',
    paddingTop: 12,
    borderTopWidth: 1,
  },
  summaryStat: { flex: 1 },
  summaryStatHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  summaryStatLabel: {
    fontFamily: 'medium',
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  summaryStatValue: { fontFamily: 'bold', fontSize: 18, marginTop: 4 },
  summaryStatCount: { fontFamily: 'regular', fontSize: 11, marginTop: 2 },
  summaryDivider: { width: 1, marginHorizontal: 12 },
  subheading: {
    fontFamily: 'medium',
    fontSize: 12,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: 12,
    marginBottom: 8,
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    borderRadius: 14,
    borderWidth: 1,
  },
  emptyTitle: { fontFamily: 'bold', fontSize: 18, marginTop: 10 },
  emptyBody: { fontFamily: 'medium', fontSize: 13, textAlign: 'center', marginTop: 4 },
  loaderRow: { paddingVertical: 18, alignItems: 'center' },
  errorBox: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 10 },
  errorText: { fontFamily: 'medium', fontSize: 13 },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 8,
  },
  eventBody: { flex: 1, marginLeft: 12 },
  eventMessage: { fontFamily: 'medium', fontSize: 13 },
  eventTime: { fontFamily: 'regular', fontSize: 11, marginTop: 2 },
  txRow: {
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 8,
  },
  txTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  txExpand: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    gap: 8,
  },
  expandRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  expandText: {
    flex: 1,
    fontFamily: 'medium',
    fontSize: 12,
    lineHeight: 17,
  },
  txIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  txBody: { flex: 1, marginLeft: 12 },
  txCounterparty: { fontFamily: 'semiBold', fontSize: 14 },
  txDate: { fontFamily: 'regular', fontSize: 11, marginTop: 2 },
  txDescription: { fontFamily: 'regular', fontSize: 11, marginTop: 2 },
  txAmountColumn: { alignItems: 'flex-end' },
  txAmount: { fontFamily: 'bold', fontSize: 15 },
  txBalance: { fontFamily: 'regular', fontSize: 11, marginTop: 2 },
});

export default ReportsScreen;
