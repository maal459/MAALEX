import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../context/SessionContext';
import { useTheme } from '../theme/ThemeContext';

const formatBalance = (value) => {
  const numeric = Number.parseFloat(String(value || '').replace(/,/g, ''));

  if (!Number.isFinite(numeric)) {
    return '—';
  }

  return numeric.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

const eventMeta = (type) => {
  if (type === 'auto_transfer') {
    return { icon: 'arrow-up-circle', label: 'Sent' };
  }

  if (type === 'balance_increase') {
    return { icon: 'arrow-down-circle', label: 'Received' };
  }

  if (type === 'rate_limited') {
    return { icon: 'pause-circle', label: 'Paused' };
  }

  return { icon: 'information-circle', label: 'Info' };
};

const formatTime = (isoString) => {
  if (!isoString) {
    return '';
  }

  try {
    return new Date(isoString).toLocaleTimeString();
  } catch {
    return '';
  }
};

const LiveScreen = () => {
  const { colors } = useTheme();
  const {
    isSignedIn,
    requiresOtp,
    sessionExpired,
    accountHolderName,
    accountLabel,
    balanceUsd,
    recentEvents,
    autoTransferState,
    snapshot,
    triggerBalance,
  } = useSession();

  const flashAnim = useRef(new Animated.Value(0)).current;
  const previousBalanceRef = useRef(balanceUsd);
  const [flashTone, setFlashTone] = useState('up');

  useEffect(() => {
    const prev = Number.parseFloat(String(previousBalanceRef.current || '').replace(/,/g, ''));
    const next = Number.parseFloat(String(balanceUsd || '').replace(/,/g, ''));

    if (Number.isFinite(prev) && Number.isFinite(next) && prev !== next) {
      setFlashTone(next > prev ? 'up' : 'down');
      flashAnim.setValue(1);
      Animated.timing(flashAnim, {
        toValue: 0,
        duration: 1200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
    }

    previousBalanceRef.current = balanceUsd;
  }, [balanceUsd, flashAnim]);

  const flashBackground = flashAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [
      colors.surfaceElevated,
      flashTone === 'up' ? 'rgba(34, 197, 94, 0.35)' : 'rgba(239, 68, 68, 0.30)',
    ],
  });

  if (!isSignedIn) {
    const expired = sessionExpired;
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
        <View style={styles.emptyState}>
          <Ionicons
            name={expired ? 'warning-outline' : 'cellular-outline'}
            size={48}
            color={expired ? colors.danger : colors.textMuted}
          />
          <Text style={[styles.emptyTitle, { color: expired ? colors.danger : colors.textPrimary }]}>
            {expired ? 'Session expired' : 'Not signed in'}
          </Text>
          <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
            {expired
              ? 'Telesom dropped your session. Open the Setup tab and sign in again to resume auto-transfer.'
              : requiresOtp
              ? 'Enter the SMS code on the Setup tab to finish signing in.'
              : 'Use the Setup tab to sign in to MyMerchant.'}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const events = [...(recentEvents || [])].reverse();
  const status = snapshot?.status || '';

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.holder, { color: colors.textPrimary }]}>
          {accountHolderName || 'MyAccount'}
        </Text>
        {accountLabel ? (
          <Text style={[styles.holderSub, { color: colors.textSecondary }]}>{accountLabel}</Text>
        ) : null}

        <Animated.View
          style={[
            styles.balanceCard,
            { backgroundColor: flashBackground, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.balanceLabel, { color: colors.textSecondary }]}>Live balance</Text>
          <View style={styles.balanceRow}>
            <Text style={[styles.currency, { color: colors.primary }]}>$</Text>
            <Text style={[styles.balanceValue, { color: colors.textPrimary }]}>
              {formatBalance(balanceUsd)}
            </Text>
          </View>
          <View style={styles.metaRow}>
            <View
              style={[
                styles.dot,
                { backgroundColor: status === 'connected' ? colors.success : colors.warning },
              ]}
            />
            <Text style={[styles.metaText, { color: colors.textSecondary }]}>
              {status === 'connected' ? 'Watching' : 'Loading…'}
            </Text>
          </View>
        </Animated.View>

        <View style={styles.statRow}>
          <View
            style={[
              styles.statCard,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.statLabel, { color: colors.textMuted }]}>Threshold</Text>
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>
              ${triggerBalance || '—'}
            </Text>
          </View>
          <View
            style={[
              styles.statCard,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.statLabel, { color: colors.textMuted }]}>Recipient</Text>
            <Text
              style={[styles.statValue, { color: colors.textPrimary }]}
              numberOfLines={1}
            >
              {autoTransferState?.recipientNumber || '—'}
            </Text>
          </View>
        </View>

        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Activity</Text>
        {events.length === 0 ? (
          <View style={[styles.empty, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              No activity yet. Waiting for funds…
            </Text>
          </View>
        ) : (
          events.map((event) => {
            const meta = eventMeta(event.type);
            const tone =
              event.type === 'auto_transfer'
                ? colors.primary
                : event.type === 'balance_increase'
                ? colors.success
                : event.type === 'rate_limited'
                ? colors.warning
                : colors.textSecondary;

            return (
              <View
                key={event.id}
                style={[styles.eventRow, { backgroundColor: colors.surface, borderColor: colors.border }]}
              >
                <View style={[styles.eventIcon, { backgroundColor: tone + '22' }]}>
                  <Ionicons name={meta.icon} size={18} color={tone} />
                </View>
                <View style={styles.eventBody}>
                  <Text style={[styles.eventMessage, { color: colors.textPrimary }]}>
                    {event.message}
                  </Text>
                  <Text style={[styles.eventTime, { color: colors.textMuted }]}>
                    {formatTime(event.at)}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { padding: 20, paddingBottom: 40 },
  holder: { fontFamily: 'bold', fontSize: 22 },
  holderSub: { fontFamily: 'medium', fontSize: 13, marginBottom: 18 },
  balanceCard: {
    borderRadius: 24,
    padding: 22,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 18,
  },
  balanceLabel: {
    fontFamily: 'medium',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1.4,
  },
  balanceRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 6 },
  currency: { fontFamily: 'bold', fontSize: 28, marginRight: 4 },
  balanceValue: { fontFamily: 'bold', fontSize: 44 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  metaText: { fontFamily: 'medium', fontSize: 13 },
  statRow: { flexDirection: 'row', gap: 12, marginTop: 16, marginBottom: 18 },
  statCard: { flex: 1, borderRadius: 16, padding: 14, borderWidth: 1 },
  statLabel: {
    fontFamily: 'medium',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  statValue: { fontFamily: 'bold', fontSize: 16, marginTop: 4 },
  sectionTitle: { fontFamily: 'semiBold', fontSize: 15, marginBottom: 10, marginTop: 4 },
  empty: { borderRadius: 14, padding: 16, borderWidth: 1 },
  emptyText: { fontFamily: 'medium', fontSize: 13 },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
  },
  eventIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  eventBody: { flex: 1 },
  eventMessage: { fontFamily: 'medium', fontSize: 13 },
  eventTime: { fontFamily: 'regular', fontSize: 11, marginTop: 2 },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30 },
  emptyTitle: { fontFamily: 'bold', fontSize: 18, marginTop: 10, marginBottom: 8 },
  emptySubtitle: { fontFamily: 'medium', fontSize: 13, textAlign: 'center' },
});

export default LiveScreen;
