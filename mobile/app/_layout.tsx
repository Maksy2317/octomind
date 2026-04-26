import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#0F0F1A' },
          headerTintColor: '#FFFFFF',
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: '#0F0F1A' },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(screens)/upload" options={{ title: 'Upload Video' }} />
        <Stack.Screen name="(screens)/format" options={{ title: 'Choose Format' }} />
        <Stack.Screen name="(screens)/analyzing" options={{ title: 'AI Analysis', headerBackVisible: false }} />
        <Stack.Screen name="(screens)/templates" options={{ title: 'Choose Template' }} />
        <Stack.Screen name="(screens)/preview" options={{ title: 'Preview' }} />
        <Stack.Screen name="(screens)/export" options={{ title: 'Export', headerBackVisible: false }} />
      </Stack>
    </SafeAreaProvider>
  );
}
