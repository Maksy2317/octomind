import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../store/useAppStore';

export default function WelcomeScreen() {
  const reset = useAppStore(s => s.reset);

  function handleStart() {
    reset();
    router.push('/(screens)/upload');
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.hero}>
        <View style={styles.iconContainer}>
          <Text style={styles.iconEmoji}>🎬</Text>
        </View>
        <Text style={styles.title}>AI Marketer</Text>
        <Text style={styles.subtitle}>
          Upload your video — AI picks the perfect template for Stories, Reels, or TikTok
        </Text>
      </View>

      <View style={styles.features}>
        {FEATURES.map((f) => (
          <View key={f.label} style={styles.featureRow}>
            <Text style={styles.featureIcon}>{f.icon}</Text>
            <Text style={styles.featureText}>{f.label}</Text>
          </View>
        ))}
      </View>

      <View style={styles.footer}>
        <TouchableOpacity style={styles.ctaButton} onPress={handleStart} activeOpacity={0.85}>
          <Text style={styles.ctaText}>Get Started</Text>
        </TouchableOpacity>
        <Text style={styles.disclaimer}>No account needed · Works offline analysis coming soon</Text>
      </View>
    </SafeAreaView>
  );
}

const FEATURES = [
  { icon: '🤖', label: 'AI analyzes your video content & mood' },
  { icon: '✨', label: 'Auto-selects the best template' },
  { icon: '📱', label: 'Optimized for Stories, Reels & TikTok' },
  { icon: '⚡', label: 'Export in seconds' },
];

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F0F1A',
    paddingHorizontal: 24,
  },
  hero: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  iconContainer: {
    width: 96,
    height: 96,
    borderRadius: 24,
    backgroundColor: '#1E1E3A',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  iconEmoji: {
    fontSize: 48,
  },
  title: {
    fontSize: 36,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 16,
    color: '#8B8BA7',
    textAlign: 'center',
    lineHeight: 24,
    maxWidth: 280,
  },
  features: {
    gap: 14,
    marginBottom: 32,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#1A1A2E',
    borderRadius: 12,
    padding: 14,
  },
  featureIcon: {
    fontSize: 20,
  },
  featureText: {
    color: '#C8C8E8',
    fontSize: 14,
    flex: 1,
  },
  footer: {
    gap: 12,
    paddingBottom: 16,
  },
  ctaButton: {
    backgroundColor: '#6C63FF',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
  },
  ctaText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  disclaimer: {
    color: '#4A4A6A',
    fontSize: 12,
    textAlign: 'center',
  },
});
