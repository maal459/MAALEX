import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../context/SessionContext';
import { useTheme } from '../theme/ThemeContext';

const SetupScreen = () => {
  const { colors } = useTheme();
  const {
    loginIdentifier,
    setLoginIdentifier,
    recipientNumber,
    setRecipientNumber,
    triggerBalance,
    setTriggerBalance,
    currency,
    setCurrency,
    pin,
    setPin,
    password,
    setPassword,
    busy,
    errorMessage,
    requiresOtp,
    isSignedIn,
    accountHolderName,
    accountLabel,
    startSignIn,
    submitOtp,
    signOut,
  } = useSession();

  const [otpCode, setOtpCode] = useState('');

  const handleSignIn = async () => {
    // Keep password in state so it survives the next launch — user only
    // needs to enter the OTP after a session expires.
    await startSignIn(password);
  };

  const handleSubmitOtp = async () => {
    const ok = await submitOtp(otpCode);
    if (ok) {
      setOtpCode('');
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={[styles.heading, { color: colors.textPrimary }]}>
            {isSignedIn ? 'Settings' : 'Sign in'}
          </Text>

          {isSignedIn && accountHolderName ? (
            <View
              style={[
                styles.profileCard,
                { backgroundColor: colors.surfaceElevated, borderLeftColor: colors.primary },
              ]}
            >
              <Text style={[styles.profileLabel, { color: colors.textMuted }]}>Signed in as</Text>
              <Text style={[styles.profileName, { color: colors.textPrimary }]}>{accountHolderName}</Text>
              {accountLabel ? (
                <Text style={[styles.profileAccount, { color: colors.textSecondary }]}>{accountLabel}</Text>
              ) : null}
            </View>
          ) : null}

          {!isSignedIn && !requiresOtp ? (
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.iconLabelRow}>
                <Ionicons name="phone-portrait-outline" size={16} color={colors.textSecondary} />
                <Text style={[styles.label, { color: colors.textSecondary }]}>Phone number</Text>
              </View>
              <TextInput
                style={[styles.input, inputStyles(colors)]}
                placeholder="0634XXXXXX"
                placeholderTextColor={colors.textMuted}
                keyboardType="phone-pad"
                value={loginIdentifier}
                onChangeText={setLoginIdentifier}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <View style={styles.iconLabelRow}>
                <Ionicons name="cash-outline" size={16} color={colors.textSecondary} />
                <Text style={[styles.label, { color: colors.textSecondary }]}>Currency</Text>
              </View>
              <View style={styles.segmentRow}>
                {[
                  { code: '840', label: 'USD' },
                  { code: '706', label: 'SOS' },
                ].map((opt) => {
                  const active = currency === opt.code;
                  return (
                    <TouchableOpacity
                      key={opt.code}
                      onPress={() => setCurrency(opt.code)}
                      style={[
                        styles.segmentButton,
                        {
                          backgroundColor: active ? colors.primary : colors.background,
                          borderColor: active ? colors.primary : colors.border,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.segmentText,
                          { color: active ? colors.onPrimary : colors.textSecondary },
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={styles.iconLabelRow}>
                <Ionicons name="lock-closed-outline" size={16} color={colors.textSecondary} />
                <Text style={[styles.label, { color: colors.textSecondary }]}>Password</Text>
              </View>
              <TextInput
                style={[styles.input, inputStyles(colors)]}
                placeholder="MyMerchant password"
                placeholderTextColor={colors.textMuted}
                secureTextEntry
                value={password}
                onChangeText={setPassword}
              />

              <TouchableOpacity
                style={[styles.primaryButton, { backgroundColor: colors.primary }, busy && { opacity: 0.6 }]}
                onPress={handleSignIn}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={[styles.primaryButtonText, { color: colors.onPrimary }]}>Sign in</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : null}

          {requiresOtp ? (
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.iconLabelRow}>
                <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.textSecondary} />
                <Text style={[styles.label, { color: colors.textSecondary }]}>SMS code</Text>
              </View>
              <TextInput
                style={[styles.input, styles.otpInput, inputStyles(colors)]}
                placeholder="••••••"
                placeholderTextColor={colors.textMuted}
                keyboardType="number-pad"
                value={otpCode}
                onChangeText={setOtpCode}
                maxLength={6}
              />

              <TouchableOpacity
                style={[styles.primaryButton, { backgroundColor: colors.primary }, busy && { opacity: 0.6 }]}
                onPress={handleSubmitOtp}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={[styles.primaryButtonText, { color: colors.onPrimary }]}>Verify</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : null}

          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.cardHeadingRow}>
              <Ionicons name="flash-outline" size={18} color={colors.primary} />
              <Text style={[styles.cardHeading, { color: colors.textPrimary }]}>Auto-transfer</Text>
            </View>

            <View style={styles.iconLabelRow}>
              <Ionicons name="person-outline" size={16} color={colors.textSecondary} />
              <Text style={[styles.label, { color: colors.textSecondary }]}>Recipient number</Text>
            </View>
            <TextInput
              style={[styles.input, inputStyles(colors)]}
              placeholder="0634XXXXXX"
              placeholderTextColor={colors.textMuted}
              keyboardType="phone-pad"
              value={recipientNumber}
              onChangeText={setRecipientNumber}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <View style={styles.iconLabelRow}>
              <Ionicons name="trending-up-outline" size={16} color={colors.textSecondary} />
              <Text style={[styles.label, { color: colors.textSecondary }]}>Threshold (USD)</Text>
            </View>
            <TextInput
              style={[styles.input, inputStyles(colors)]}
              placeholder="600"
              placeholderTextColor={colors.textMuted}
              keyboardType="decimal-pad"
              value={triggerBalance}
              onChangeText={setTriggerBalance}
            />

            <View style={styles.iconLabelRow}>
              <Ionicons name="keypad-outline" size={16} color={colors.textSecondary} />
              <Text style={[styles.label, { color: colors.textSecondary }]}>Transaction PIN</Text>
            </View>
            <TextInput
              style={[styles.input, inputStyles(colors)]}
              placeholder="••••"
              placeholderTextColor={colors.textMuted}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={6}
              value={pin}
              onChangeText={(value) => setPin(value.replace(/\D/g, ''))}
            />
            <Text style={[styles.helperText, { color: colors.textMuted }]}>
              Required for auto-transfer. Stored in memory only — re-enter after app restart.
            </Text>
          </View>

          {errorMessage ? (
            <View
              style={[
                styles.errorBox,
                { backgroundColor: 'rgba(239,68,68,0.08)', borderColor: colors.danger },
              ]}
            >
              <Text style={[styles.errorText, { color: colors.danger }]}>{errorMessage}</Text>
            </View>
          ) : null}

          {isSignedIn ? (
            <TouchableOpacity
              style={[styles.signOutButton, { borderColor: colors.border }]}
              onPress={signOut}
            >
              <Ionicons name="log-out-outline" size={18} color={colors.textSecondary} />
              <Text style={[styles.signOutText, { color: colors.textSecondary }]}>Sign out</Text>
            </TouchableOpacity>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const inputStyles = (colors) => ({
  backgroundColor: colors.background,
  color: colors.textPrimary,
  borderColor: colors.border,
});

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: { padding: 20, paddingBottom: 40 },
  heading: { fontSize: 24, fontFamily: 'bold', marginBottom: 18 },
  profileCard: {
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    borderLeftWidth: 4,
  },
  profileLabel: {
    fontFamily: 'medium',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  profileName: { fontFamily: 'bold', fontSize: 18, marginTop: 2 },
  profileAccount: { fontFamily: 'medium', fontSize: 13, marginTop: 2 },
  card: { borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: 1 },
  cardHeadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  cardHeading: { fontFamily: 'semiBold', fontSize: 16 },
  iconLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, marginBottom: 6 },
  label: {
    fontFamily: 'medium',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  input: {
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontFamily: 'medium',
    fontSize: 15,
    borderWidth: 1,
  },
  otpInput: {
    fontSize: 22,
    letterSpacing: 6,
    textAlign: 'center',
    fontFamily: 'bold',
  },
  primaryButton: {
    marginTop: 16,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonText: { fontFamily: 'bold', fontSize: 15 },
  errorBox: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 4, marginBottom: 14 },
  errorText: { fontFamily: 'medium', fontSize: 13 },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  signOutText: { fontFamily: 'semiBold', fontSize: 14 },
  segmentRow: { flexDirection: 'row', gap: 8 },
  segmentButton: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
  },
  segmentText: { fontFamily: 'semiBold', fontSize: 14, letterSpacing: 0.6 },
  helperText: { fontFamily: 'medium', fontSize: 11, marginTop: 6 },
});

export default SetupScreen;
