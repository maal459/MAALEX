import AsyncStorage from '@react-native-async-storage/async-storage';

const DEVICE_ID_KEY = '@maalex/device-id';

let cachedDeviceId = '';

const generateDeviceId = () => {
  // Random 24-byte (approx) base36-ish identifier. Not cryptographic — just
  // stable per-install. We store and reuse.
  const a = Date.now().toString(36);
  const b = Math.random().toString(36).slice(2, 12);
  const c = Math.random().toString(36).slice(2, 12);
  return `${a}-${b}${c}`;
};

export const getDeviceId = async () => {
  if (cachedDeviceId) {
    return cachedDeviceId;
  }

  try {
    const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (stored && stored.length >= 8) {
      cachedDeviceId = stored;
      return stored;
    }
  } catch {
    // fall through
  }

  const fresh = generateDeviceId();
  cachedDeviceId = fresh;

  try {
    await AsyncStorage.setItem(DEVICE_ID_KEY, fresh);
  } catch {
    // best effort — in-memory cache still works
  }

  return fresh;
};

export const getCachedDeviceId = () => cachedDeviceId;
