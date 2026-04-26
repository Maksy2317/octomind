import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Alert } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../../store/useAppStore';
import { analyzeVideo } from '../../services/api';

const STEPS = [
  { label: 'Extracting key frames...', duration: 1200 },
  { label: 'Analyzing visual content...', duration: 1500 },
  { label: 'Detecting mood & energy...', duration: 1000 },
  { label: 'Matching templates...', duration: 800 },
];

export default function AnalyzingScreen() {
  const [currentStep, setCurrentStep] = React.useState(0);
  const progress = useRef(new Animated.Value(0)).current;
  const store = useAppStore();

  useEffect(() => {
    runAnalysis();
  }, []);

  // Animate progress bar
  useEffect(() => {
    Animated.timing(progress, {
      toValue: ((currentStep + 1) / STEPS.length) * 100,
      duration: STEPS[currentStep]?.duration ?? 800,
      useNativeDriver: false,
    }).start();
  }, [currentStep]);

  async function runAnalysis() {
    try {
      // Step through UI animation while API call runs in parallel
      const stepTimers = STEPS.map((step, i) =>
        new Promise<void>(resolve => {
          const delay = STEPS.slice(0, i).reduce((sum, s) => sum + s.duration, 0);
          setTimeout(() => {
            setCurrentStep(i);
            resolve();
          }, delay);
        }),
      );

      const [apiResult] = await Promise.all([
        analyzeVideo(store.videoId!, store.selectedFormat!),
        ...stepTimers,
      ]);

      store.setAnalysis(apiResult.analysis, apiResult.templates);

      // Brief pause so last step is visible
      setTimeout(() => router.push('/(screens)/templates'), 400);
    } catch (error: any) {
      Alert.alert(
        'Analysis failed',
        error?.response?.data?.error || error.message || 'Please try again.',
        [{ text: 'Go Back', onPress: () => router.back() }],
      );
    }
  }

  const progressWidth = progress.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.brain}>
          <Text style={styles.brainEmoji}>🤖</Text>
          <View style={styles.pulse} />
        </View>

        <View style={styles.textBlock}>
          <Text style={styles.title}>AI is analyzing{'\n'}your video</Text>
          <Text style={styles.subtitle}>
            Detecting content, mood, colors, and energy level to find the perfect template.
          </Text>
        </View>

        <View style={styles.progressSection}>
          <View style={styles.progressTrack}>
            <Animated.View style={[styles.progressFill, { width: progressWidth }]} />
          </View>

          <View style={styles.steps}>
            {STEPS.map((step, i) => (
              <View key={step.label} style={styles.stepRow}>
                <View style={[
                  styles.stepDot,
                  i < currentStep && styles.stepDotDone,
                  i === currentStep && styles.stepDotActive,
                ]} />
                <Text style={[
                  styles.stepText,
                  i === currentStep && styles.stepTextActive,
                  i < currentStep && styles.stepTextDone,
                ]}>
                  {step.label}
                </Text>
                {i < currentStep && <Text style={styles.checkmark}>✓</Text>}
              </View>
            ))}
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F0F1A' },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 40,
  },
  brain: {
    position: 'relative',
    width: 120,
    height: 120,
    justifyContent: 'center',
    alignItems: 'center',
  },
  brainEmoji: { fontSize: 72 },
  pulse: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#6C63FF22',
  },
  textBlock: { alignItems: 'center', gap: 10 },
  title: { fontSize: 28, fontWeight: '800', color: '#FFFFFF', textAlign: 'center', lineHeight: 36 },
  subtitle: { fontSize: 14, color: '#8B8BA7', textAlign: 'center', lineHeight: 22, maxWidth: 280 },
  progressSection: { width: '100%', gap: 20 },
  progressTrack: {
    height: 6,
    backgroundColor: '#2A2A4A',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#6C63FF',
    borderRadius: 3,
  },
  steps: { gap: 12 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#2A2A4A',
  },
  stepDotActive: { backgroundColor: '#6C63FF' },
  stepDotDone: { backgroundColor: '#4CAF50' },
  stepText: { fontSize: 14, color: '#4A4A6A', flex: 1 },
  stepTextActive: { color: '#FFFFFF', fontWeight: '600' },
  stepTextDone: { color: '#5A7A5A' },
  checkmark: { color: '#4CAF50', fontSize: 14 },
});
