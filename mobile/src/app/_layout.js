import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { C } from '../lib/theme';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerTintColor: C.green,
          headerTitleStyle: { color: C.ink, fontWeight: '700' },
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: { backgroundColor: C.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'SimonStays' }} />
        <Stack.Screen name="unit/[id]" options={{ title: '' }} />
        <Stack.Screen name="book/[unitId]" options={{ title: 'Confirm and pay' }} />
        <Stack.Screen name="booking/[id]" options={{ title: 'Your booking', headerBackVisible: false, gestureEnabled: false }} />
        <Stack.Screen name="payment" options={{ headerShown: false }} />
      </Stack>
    </SafeAreaProvider>
  );
}
