import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { APP_NAME } from '../constants/appConfig';
import {
  getOrStartTrial,
  persistLicenseKey,
  verifyLicense,
} from '../services/licensing';
import { getDeviceId } from '../services/deviceId';

const LicenseScreen = ({ initialError, onValidated }) => {
  const { colors } = useTheme();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError || '');
  const [deviceId, setDeviceId] = useState('');

  useEffect(() => {
    getDeviceId().then(setDeviceId).catch(() => {});
  }, []);

  const handleActivate = async () => {
    const trimmed = key.trim();

    if (!trimmed) {
      setError('Enter the license key your administrator gave you.');
      return;
    }

    setBusy(true);
    setError('');

    try {
      const result = await verifyLicense(trimmed);
      if (!result.ok) {
        setError(result.reason || 'License could not be validated.');
        return;
      }
      await persistLicenseKey(trimmed);
      onValidated(result.license);
    } catch (err) {
      setError(err.message || 'License could not be validated.');
    } finally {
      setBusy(false);
    }
  };

  const handleStartTrial = async () => {
    setBusy(true);
    setError('');

    try {
      const result = await getOrStartTrial();
      if (!result.ok) {
        setError(result.reason || 'Could not start the free trial.');
        return;
      }
      onValidated(result.license);
    } catch (err) {
      setError(err.message || 'Could not start the free trial.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.body}>
          <View style={styles.brandBlock}>
            <Text style={[styles.brand, { color: colors.textPrimary }]}>{APP_NAME}</Text>
            <Text style={[styles.tagline, { color: colors.textSecondary }]}>
              Activate your subscription
            </Text>
          </View>

          <View
            style={[
              styles.card,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <Text style={[styles.label, { color: colors.textSecondary }]}>License key</Text>
            <TextInput
              style={[
                styles.input,
                {
                  color: colors.textPrimary,
                  backgroundColor: colors.background,
                  borderColor: colors.border,
                },
              ]}
              placeholder="MAALEX.xxx.xxx"
              placeholderTextColor={colors.textMuted}
              value={key}
              onChangeText={setKey}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />

            <TouchableOpacity
              style={[
                styles.button,
                { backgroundColor: colors.primary },
                busy && styles.buttonDisabled,
              ]}
              onPress={handleActivate}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={[styles.buttonText, { color: colors.onPrimary }]}>Activate</Text>
              )}
            </TouchableOpacity>

            {error ? (
              <Text style={[styles.error, { color: colors.danger }]}>{error}</Text>
            ) : null}

            <View style={[styles.divider, { backgroundColor: colors.border }]} />

            <Text style={[styles.trialLabel, { color: colors.textSecondary }]}>
              No key yet?
            </Text>
            <TouchableOpacity
              style={[
                styles.trialButton,
                { borderColor: colors.primary },
                busy && styles.buttonDisabled,
              ]}
              onPress={handleStartTrial}
              disabled={busy}
            >
              <Text style={[styles.trialButtonText, { color: colors.primary }]}>
                Start 3-day free trial
              </Text>
            </TouchableOpacity>
          </View>

          {deviceId ? (
            <View style={styles.deviceBlock}>
              <Text style={[styles.deviceLabel, { color: colors.textMuted }]}>Your device ID</Text>
              <Text style={[styles.deviceId, { color: colors.textSecondary }]} selectable>
                {deviceId}
              </Text>
              <Text style={[styles.deviceHint, { color: colors.textMuted }]}>
                Share this with the developer when purchasing a license.
              </Text>
            </View>
          ) : null}

          <Text style={[styles.note, { color: colors.textMuted }]}>
            Licenses are bound to this device. Contact the developer for a key.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { flex: 1, justifyContent: 'center', padding: 24 },
  brandBlock: { alignItems: 'center', marginBottom: 28 },
  brand: { fontFamily: 'bold', fontSize: 30, letterSpacing: 2 },
  tagline: { fontFamily: 'medium', fontSize: 13, marginTop: 6, letterSpacing: 0.6 },
  card: {
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
  },
  label: {
    fontFamily: 'medium',
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  input: {
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    fontFamily: 'semiBold',
    fontSize: 13,
    letterSpacing: 0.4,
    borderWidth: 1,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  button: {
    marginTop: 16,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { fontFamily: 'bold', fontSize: 15 },
  error: { marginTop: 12, fontFamily: 'medium', fontSize: 13 },
  note: { textAlign: 'center', fontFamily: 'medium', fontSize: 12, marginTop: 18 },
  divider: { height: 1, marginTop: 22, marginBottom: 16 },
  trialLabel: {
    fontFamily: 'medium',
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginBottom: 8,
  },
  trialButton: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1.5,
  },
  trialButtonText: { fontFamily: 'bold', fontSize: 15 },
  deviceBlock: { marginTop: 24, alignItems: 'center', paddingHorizontal: 8 },
  deviceLabel: { fontFamily: 'medium', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 },
  deviceId: { fontFamily: 'semiBold', fontSize: 12, letterSpacing: 0.5, textAlign: 'center' },
  deviceHint: { fontFamily: 'regular', fontSize: 11, marginTop: 4, textAlign: 'center' },
});

export default LicenseScreen;
