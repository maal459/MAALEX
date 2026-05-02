import 'react-native-gesture-handler';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { APP_NAME } from './constants/appConfig';
import { SessionProvider, useSession } from './context/SessionContext';
import { ThemeProvider, useTheme } from './theme/ThemeContext';
import SetupScreen from './screens/SetupScreen';
import LiveScreen from './screens/LiveScreen';
import ReportsScreen from './screens/ReportsScreen';
import LicenseScreen from './screens/LicenseScreen';
import {
  clearLicenseKey,
  loadStoredLicenseKey,
  setCachedLicenseKey,
  validateLicenseRemote,
} from './services/zaadBackend';

SplashScreen.preventAutoHideAsync();

const Tab = createBottomTabNavigator();

const TAB_ICON = {
  Setup: { active: 'settings', inactive: 'settings-outline' },
  Live: { active: 'pulse', inactive: 'pulse-outline' },
  Reports: { active: 'document-text', inactive: 'document-text-outline' },
};

const Header = ({ onSignOutLicense }) => {
  const { colors, isDark, toggleMode } = useTheme();
  const { accountHolderName, isSignedIn } = useSession();
  const firstName = accountHolderName ? accountHolderName.split(/\s+/)[0] : '';

  return (
    <SafeAreaView edges={['top']} style={{ backgroundColor: colors.background }}>
      <View style={[styles.headerRow, { borderBottomColor: colors.border }]}>
        <View style={styles.headerLeft}>
          <Text style={[styles.appName, { color: colors.textPrimary }]}>{APP_NAME}</Text>
          {isSignedIn && firstName ? (
            <Text style={[styles.headerUser, { color: colors.primary }]} numberOfLines={1}>
              · {firstName}
            </Text>
          ) : null}
        </View>

        <View style={styles.headerRight}>
          <TouchableOpacity
            onPress={toggleMode}
            style={[styles.iconBtn, { borderColor: colors.border }]}
            accessibilityLabel="Toggle theme"
          >
            <Ionicons
              name={isDark ? 'sunny-outline' : 'moon-outline'}
              size={18}
              color={colors.textPrimary}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onSignOutLicense}
            style={[styles.iconBtn, { borderColor: colors.border }]}
            accessibilityLabel="License"
          >
            <Ionicons name="key-outline" size={18} color={colors.textPrimary} />
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
};

const Tabs = () => {
  const { colors } = useTheme();

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          height: Platform.OS === 'ios' ? 80 : 64,
          paddingTop: 8,
          paddingBottom: Platform.OS === 'ios' ? 22 : 8,
        },
        tabBarLabelStyle: { fontFamily: 'semiBold', fontSize: 11, letterSpacing: 0.6 },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarIcon: ({ focused, color, size }) => {
          const map = TAB_ICON[route.name] || TAB_ICON.Setup;
          return <Ionicons name={focused ? map.active : map.inactive} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Setup" component={SetupScreen} />
      <Tab.Screen name="Live" component={LiveScreen} />
      <Tab.Screen name="Reports" component={ReportsScreen} />
    </Tab.Navigator>
  );
};

const Shell = ({ onResetLicense }) => {
  const { colors } = useTheme();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Header onSignOutLicense={onResetLicense} />
      <Tabs />
    </View>
  );
};

const navTheme = (colors, isDark) => ({
  dark: isDark,
  colors: {
    primary: colors.primary,
    background: colors.background,
    card: colors.surface,
    text: colors.textPrimary,
    border: colors.border,
    notification: colors.accent,
  },
});

const ThemedRoot = ({ licenseValidated, onValidated, onResetLicense, initialError }) => {
  const { colors, isDark } = useTheme();

  if (!licenseValidated) {
    return <LicenseScreen onValidated={onValidated} initialError={initialError} />;
  }

  return (
    <NavigationContainer theme={navTheme(colors, isDark)}>
      <Shell onResetLicense={onResetLicense} />
    </NavigationContainer>
  );
};

const App = () => {
  const [fontsLoaded] = useFonts({
    black: require('./assets/fonts/Poppins-Black.ttf'),
    bold: require('./assets/fonts/Poppins-Bold.ttf'),
    medium: require('./assets/fonts/Poppins-Medium.ttf'),
    regular: require('./assets/fonts/Poppins-Regular.ttf'),
    semiBold: require('./assets/fonts/Poppins-SemiBold.ttf'),
  });

  const [licenseChecked, setLicenseChecked] = useState(false);
  const [licenseValidated, setLicenseValidated] = useState(false);
  const [licenseError, setLicenseError] = useState('');

  useEffect(() => {
    let cancelled = false;

    // Hard ceiling: never block the splash on the license check for more than
    // 15 s. If the backend is unreachable, fall through to the License screen.
    const failsafe = setTimeout(() => {
      if (!cancelled) {
        setLicenseError(
          (prev) => prev || 'MAALEX backend is unreachable. Re-enter your license key.'
        );
        setLicenseChecked(true);
      }
    }, 15_000);

    (async () => {
      const stored = await loadStoredLicenseKey();

      if (cancelled) {
        return;
      }

      if (!stored) {
        setLicenseChecked(true);
        return;
      }

      setCachedLicenseKey(stored);

      try {
        await validateLicenseRemote(stored);
        if (!cancelled) {
          setLicenseValidated(true);
        }
      } catch (error) {
        if (!cancelled) {
          await clearLicenseKey();
          setLicenseError(error.message || 'Stored license is no longer valid.');
        }
      } finally {
        if (!cancelled) {
          setLicenseChecked(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(failsafe);
    };
  }, []);

  useEffect(() => {
    if (fontsLoaded && licenseChecked) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded, licenseChecked]);

  const handleValidated = useCallback(() => {
    setLicenseValidated(true);
    setLicenseError('');
  }, []);

  const handleResetLicense = useCallback(async () => {
    await clearLicenseKey();
    setLicenseValidated(false);
  }, []);

  if (!fontsLoaded || !licenseChecked) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#22d3ee" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <SessionProvider>
          <StatusBarBridge />
          <ThemedRoot
            licenseValidated={licenseValidated}
            onValidated={handleValidated}
            onResetLicense={handleResetLicense}
            initialError={licenseError}
          />
        </SessionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
};

const StatusBarBridge = () => {
  const { isDark, colors } = useTheme();
  return (
    <StatusBar
      barStyle={isDark ? 'light-content' : 'dark-content'}
      backgroundColor={colors.background}
    />
  );
};

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 8 },
  appName: { fontFamily: 'bold', fontSize: 20, letterSpacing: 1.2 },
  headerUser: { fontFamily: 'semiBold', fontSize: 14, maxWidth: 160 },
  headerRight: { flexDirection: 'row', gap: 8 },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
});

export default App;
