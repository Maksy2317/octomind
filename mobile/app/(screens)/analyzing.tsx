import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, TouchableOpacity } from 'react-native';
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

// While the backend is still working we never let the bar reach 100% — it is
// capped here so the UI can't report "done" before the API actually returns.
const WAITING_CAP = 90;

export default function AnalyzingScreen() {
  const [currentStep, setCurrentStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const store = useAppStore();

  function clearTimers() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }

  async function runAnalysis() {
    // Guard: we cannot analyse without an uploaded video and a chosen format.
    if (!store.videoId || !store.selectedFormat) {
      setError('Видео или формат не выбраны. Вернитесь назад и повторите.');
      return;
    }

    setError(null);
    setCurrentStep(0);
    progress.setValue(0);
    clearTimers();

    // Advance visually through the steps, but the animated bar is capped at
    // WAITING_CAP — the last ~10% is reserved for the real API completion.
    STEPS.forEach((step, i) => {
      const delay = STEPS.slice(0, i).reduce((sum, s) => sum + s.duration, 0);
      const t = setTimeout(() => {
        setCurrentStep(i);
        const pct = Math.min(WAITING_CAP, ((i + 1) / STEPS.length) * WAITING_CAP);
        Animated.timing(progress, {
          toValue: pct,
          duration: step.duration,
          useNativeDriver: false,
        }).start();
      }, delay);
      timers.current.push(t);
    });

    try {
      // The result is driven by the API, NOT by the animation timers.
      const apiResult = await analyzeVideo(store.videoId, store.selectedFormat);
      clearTimers();
      store.setAnalysis(apiResult.analysis, apiResult.templates);

      // Only now — after the backend returned — do we complete to 100%.
      setCurrentStep(STEPS.length);
      Animated.timing(progress, {
        toValue: 100,
        duration: 300,
        useNativeDriver: false,
      }).start(() => {
        router.push('/(screens)/templates');
      });
    } catch (err: any) {
      clearTimers();
      setError(
        err?.response?.data?.error ||
        err?.message ||
        'Не удалось проанализировать видео. Проверьте соединение и попробуйте ещё раз.',
      );
    }
  }

  useEffect(() => {
    runAnalysis();
    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const progressWidth = progress.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  // ── Error state ────────────────────────────────────────────────────────────
  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.errorEmoji}>😕</Text>
          <View style={styles.textBlock}>
            <Text style={styles.title}>Что-то пошло не так</Text>
            <Text style={styles.subtitle}>{error}</Text>
          </View>
          <View style={styles.errorActions}>
            <TouchableOpacity style={styles.retryButton} onPress={runAnalysis} activeOpacity={0.85}>
              <Text style={styles.retryText}>Повторить</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.backButton} onPress={() => router.back()} activeOpacity={0.85}>
              <Text style={styles.backText}>Назад</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ── Progress state ─────────────────────────────────────────────────────────
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
  errorEmoji: { fontSize: 72 },
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
  errorActions: { width: '100%', gap: 12 },
  retryButton: {
    backgroundColor: '#6C63FF',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
  },
  retryText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  backButton: {
    backgroundColor: '#1A1A2E',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2A4A',
  },
  backText: { color: '#C8C8E8', fontSize: 16, fontWeight: '600' },
});
