import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { useSession } from '../context/SessionContext';
import { fetchZaadTransactions } from '../services/zaadBackend';

// ----- helpers -----

const inferDirection = (row) => {
  const direction = String(row?.direction || '').toLowerCase();

  if (direction.includes('credit') || direction.includes('in') || direction.includes('receive')) {
    return 'in';
  }

  if (direction.includes('debit') || direction.includes('out') || direction.includes('send')) {
    return 'out';
  }

  return 'unknown';
};

// Telesom returns dates in several shapes — try ISO, then dd/mm/yyyy hh:mm,
// then yyyy-mm-dd hh:mm:ss. Returns a Date or null.
const parseTxDate = (raw) => {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  const iso = Date.parse(value);
  if (Number.isFinite(iso)) return new Date(iso);

  // dd/mm/yyyy [hh:mm[:ss]]
  const slash = value.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\sT](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (slash) {
    const [, dd, mm, yyyy, hh = '0', mi = '0', ss = '0'] = slash;
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
  { key: 'day', label: 'Today', startFn: startOfDay },
  { key: 'week', label: 'This week', startFn: startOfWeek },
  { key: 'month', label: 'This month', startFn: startOfMonth },
  { key: 'all', label: 'All', startFn: () => new Date(0) },
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
  const { sessionId, isSignedIn, recentEvents } = useSession();
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [hasLoaded, setHasLoaded] = useState(false);
  const [period, setPeriod] = useState('day');

  const load = useCallback(
    async (mode = 'initial') => {
      if (!sessionId || !isSignedIn) return;

      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);

      setError('');

      try {
        const rows = await fetchZaadTransactions(sessionId);
        setTransactions(rows);
        setHasLoaded(true);
      } catch (err) {
        setError(err.message || 'Could not load transactions.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [isSignedIn, sessionId]
  );

  // Auto-load on first sign-in.
  useEffect(() => {
    if (isSignedIn && sessionId && !hasLoaded && !loading) {
      load('initial');
    }
  }, [hasLoaded, isSignedIn, load, loading, sessionId]);

  const enriched = useMemo(
    () =>
      (transactions || []).map((tx) => ({
        ...tx,
        _dir: inferDirection(tx),
        _amt: parseAmount(tx.amount),
        _date: parseTxDate(tx.date),
      })),
    [transactions]
  );

  const filtered = useMemo(() => {
    const def = PERIODS.find((p) => p.key === period) || PERIODS[0];
    const cutoff = def.startFn(new Date()).getTime();
    return enriched.filter((tx) => {
      if (!tx._date) return period === 'all'; // include unparseable rows under "All"
      return tx._date.getTime() >= cutoff;
    });
  }, [enriched, period]);

  const summary = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    let inCount = 0;
    let outCount = 0;

    for (const tx of filtered) {
      if (tx._dir === 'in') {
        inflow += tx._amt;
        inCount += 1;
      } else if (tx._dir === 'out') {
        outflow += tx._amt;
        outCount += 1;
      }
    }

    return {
      count: filtered.length,
      inflow,
      outflow,
      net: inflow - outflow,
      inCount,
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
          <TouchableOpacity
            onPress={() => load('initial')}
            style={[styles.refreshBtn, { borderColor: colors.border }]}
          >
            <Ionicons name="refresh" size={18} color={colors.primary} />
          </TouchableOpacity>
        </View>

        {/* period selector */}
        <View style={styles.periodRow}>
          {PERIODS.map((p) => {
            const active = p.key === period;
            return (
              <TouchableOpacity
                key={p.key}
                onPress={() => setPeriod(p.key)}
                style={[
                  styles.periodBtn,
                  {
                    backgroundColor: active ? colors.primary : colors.surface,
                    borderColor: active ? colors.primary : colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.periodText,
                    { color: active ? colors.onPrimary : colors.textSecondary },
                  ]}
                >
                  {p.label}
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
            <Text style={[styles.summaryNetLabel, { color: colors.textSecondary }]}>Net</Text>
            <Text
              style={[
                styles.summaryNetValue,
                {
                  color:
                    summary.net > 0
                      ? colors.success
                      : summary.net < 0
                      ? colors.danger
                      : colors.textPrimary,
                },
              ]}
            >
              {summary.net >= 0 ? '+' : '−'}${formatMoney(Math.abs(summary.net))}
            </Text>
          </View>

          <View style={[styles.summarySplit, { borderTopColor: colors.border }]}>
            <View style={styles.summaryStat}>
              <View style={styles.summaryStatHead}>
                <Ionicons name="arrow-down" size={14} color={colors.success} />
                <Text style={[styles.summaryStatLabel, { color: colors.textSecondary }]}>
                  Received
                </Text>
              </View>
              <Text style={[styles.summaryStatValue, { color: colors.success }]}>
                ${formatMoney(summary.inflow)}
              </Text>
              <Text style={[styles.summaryStatCount, { color: colors.textMuted }]}>
                {summary.inCount} in
              </Text>
            </View>

            <View style={[styles.summaryDivider, { backgroundColor: colors.border }]} />

            <View style={styles.summaryStat}>
              <View style={styles.summaryStatHead}>
                <Ionicons name="arrow-up" size={14} color={colors.danger} />
                <Text style={[styles.summaryStatLabel, { color: colors.textSecondary }]}>Sent</Text>
              </View>
              <Text style={[styles.summaryStatValue, { color: colors.danger }]}>
                ${formatMoney(summary.outflow)}
              </Text>
              <Text style={[styles.summaryStatCount, { color: colors.textMuted }]}>
                {summary.outCount} out
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

        {/* MyMerchant transactions for the chosen period */}
        <Text style={[styles.subheading, { color: colors.textSecondary, marginTop: 18 }]}>
          MyMerchant transactions
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

          return (
            <View
              key={tx.id}
              style={[
                styles.txRow,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ]}
            >
              <View style={[styles.txIcon, { backgroundColor: tone + '22' }]}>
                <Ionicons name={arrow} size={18} color={tone} />
              </View>
              <View style={styles.txBody}>
                <Text style={[styles.txCounterparty, { color: colors.textPrimary }]} numberOfLines={1}>
                  {tx.counterparty || tx.description || 'Transaction'}
                </Text>
                <Text style={[styles.txDate, { color: colors.textMuted }]}>
                  {tx._date ? tx._date.toLocaleString() : tx.date || ''}
                </Text>
              </View>
              <View style={styles.txAmountColumn}>
                <Text style={[styles.txAmount, { color: tone }]}>
                  {tx._amt ? `$${formatMoney(tx._amt)}` : '—'}
                </Text>
                {tx.balanceAfter ? (
                  <Text style={[styles.txBalance, { color: colors.textMuted }]}>
                    bal ${tx.balanceAfter}
                  </Text>
                ) : null}
              </View>
            </View>
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
  periodBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
  },
  periodText: { fontFamily: 'semiBold', fontSize: 12, letterSpacing: 0.4 },
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
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 8,
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
  txAmountColumn: { alignItems: 'flex-end' },
  txAmount: { fontFamily: 'bold', fontSize: 15 },
  txBalance: { fontFamily: 'regular', fontSize: 11, marginTop: 2 },
});

export default ReportsScreen;
