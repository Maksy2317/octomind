import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Screen = 'welcome' | 'upload' | 'format' | 'analyzing' | 'templates' | 'preview' | 'export';

export default function DemoApp() {
  const [screen, setScreen] = useState<Screen>('welcome');
  const [selectedFormat, setSelectedFormat] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const goToScreen = (s: Screen) => {
    setScreen(s);
    if (s === 'analyzing') {
      // Simulate analysis
      let p = 0;
      const interval = setInterval(() => {
        p += Math.random() * 30;
        if (p >= 100) {
          setProgress(100);
          clearInterval(interval);
        } else {
          setProgress(p);
        }
      }, 800);
    }
  };

  if (screen === 'welcome') {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.hero}>
            <Text style={styles.emoji}>🎬</Text>
            <Text style={styles.title}>AI Marketer</Text>
            <Text style={styles.subtitle}>
              Upload your video — AI picks the perfect template for Stories, Reels, or TikTok
            </Text>
          </View>

          <View style={styles.features}>
            {[
              { icon: '🤖', text: 'AI analyzes your video content & mood' },
              { icon: '✨', text: 'Auto-selects the best template' },
              { icon: '📱', text: 'Optimized for Stories, Reels & TikTok' },
              { icon: '⚡', text: 'Export in seconds' },
            ].map((f, i) => (
              <View key={i} style={styles.feature}>
                <Text style={styles.featureIcon}>{f.icon}</Text>
                <Text style={styles.featureText}>{f.text}</Text>
              </View>
            ))}
          </View>

          <TouchableOpacity
            style={styles.button}
            onPress={() => goToScreen('upload')}
          >
            <Text style={styles.buttonText}>Get Started</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === 'upload') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => goToScreen('welcome')}>
            <Text style={styles.backBtn}>← Back</Text>
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.step}>Step 1 of 5</Text>
          <Text style={styles.title}>Upload Your Video</Text>
          <Text style={styles.desc}>Select a video from your device.</Text>

          <View style={styles.dropzone}>
            <Text style={styles.icon}>🎥</Text>
            <Text style={styles.dropTitle}>Add your video</Text>
            <Text style={styles.dropSub}>MP4, MOV, AVI · Max 200MB</Text>
          </View>

          <TouchableOpacity
            style={styles.button}
            onPress={() => {
              Alert.alert('✅ Video selected');
              goToScreen('format');
            }}
          >
            <Text style={styles.buttonText}>📷 Choose Video</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === 'format') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => goToScreen('upload')}>
            <Text style={styles.backBtn}>← Back</Text>
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.step}>Step 2 of 5</Text>
          <Text style={styles.title}>Choose Format</Text>
          <Text style={styles.desc}>Where will you post this video?</Text>

          {[
            { id: 'stories', name: 'Instagram Stories', emoji: '📸', desc: 'Full-screen vertical' },
            { id: 'reels', name: 'Instagram Reels', emoji: '🎬', desc: 'Short-form vertical' },
            { id: 'tiktok', name: 'TikTok', emoji: '🎵', desc: 'Optimized for TikTok' },
          ].map((f) => (
            <TouchableOpacity
              key={f.id}
              style={[styles.card, selectedFormat === f.id && styles.cardSelected]}
              onPress={() => setSelectedFormat(f.id)}
            >
              <Text style={styles.cardEmoji}>{f.emoji}</Text>
              <View style={styles.cardInfo}>
                <Text style={styles.cardName}>{f.name}</Text>
                <Text style={styles.cardDesc}>{f.desc}</Text>
              </View>
              <View
                style={[
                  styles.radio,
                  selectedFormat === f.id && styles.radioSelected,
                ]}
              >
                {selectedFormat === f.id && <View style={styles.radioDot} />}
              </View>
            </TouchableOpacity>
          ))}

          <TouchableOpacity
            style={[styles.button, !selectedFormat && styles.buttonDisabled]}
            onPress={() => goToScreen('analyzing')}
            disabled={!selectedFormat}
          >
            <Text style={styles.buttonText}>Analyze with AI →</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === 'analyzing') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centerContent}>
          <Text style={styles.largeEmoji}>🤖</Text>
          <Text style={styles.title}>AI is analyzing</Text>
          <Text style={styles.desc} style={{ marginBottom: 40 }}>
            Detecting content, mood, colors...
          </Text>

          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${progress}%` }]} />
          </View>

          {[
            'Extracting key frames...',
            'Analyzing visual content...',
            'Detecting mood & energy...',
            'Matching templates...',
          ].map((step, i) => (
            <View key={i} style={styles.stepItem}>
              <View
                style={[
                  styles.stepDot,
                  progress > i * 25 && styles.stepDotDone,
                ]}
              />
              <Text style={styles.stepText}>{step}</Text>
              {progress > i * 25 && <Text style={styles.check}>✓</Text>}
            </View>
          ))}

          <TouchableOpacity
            style={[styles.button, { marginTop: 40 }]}
            onPress={() => {
              setProgress(100);
              setTimeout(() => goToScreen('templates'), 500);
            }}
          >
            <Text style={styles.buttonText}>Continue →</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (screen === 'templates') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => goToScreen('analyzing')}>
            <Text style={styles.backBtn}>← Back</Text>
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.step}>Step 3 of 5</Text>
          <Text style={styles.title}>Choose Template</Text>
          <Text style={styles.desc}>AI picked the best templates for your content</Text>

          {[
            { id: 1, name: '✨ Vibrant Pop', desc: 'High energy, saturated colors', tag: '✨ AI Pick' },
            { id: 2, name: 'Neon Gradient', desc: 'Bold and modern look' },
            { id: 3, name: 'Cinematic Dark', desc: 'Professional cinematic grade' },
          ].map((t) => (
            <TouchableOpacity key={t.id} style={styles.templateCard}>
              <View style={styles.templateIcon}>🎨</View>
              <View style={styles.templateInfo}>
                <Text style={styles.templateName}>{t.name}</Text>
                <Text style={styles.templateDesc}>{t.desc}</Text>
              </View>
              {t.tag && <View style={styles.aiPickBadge}><Text style={styles.aiPickText}>{t.tag}</Text></View>}
            </TouchableOpacity>
          ))}

          <TouchableOpacity
            style={styles.button}
            onPress={() => goToScreen('preview')}
          >
            <Text style={styles.buttonText}>Apply Template →</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === 'preview') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => goToScreen('templates')}>
            <Text style={styles.backBtn}>← Back</Text>
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.step}>Step 4 of 5</Text>
          <Text style={styles.title}>Preview</Text>

          <View style={styles.videoPreview}>
            <Text style={styles.videoEmoji}>🎬</Text>
            <Text style={styles.videoText}>Video Preview</Text>
          </View>

          <View style={styles.infoBox}>
            <Text style={styles.infoLabel}>Template: Vibrant Pop</Text>
            <Text style={styles.infoLabel}>Format: Instagram Reels</Text>
            <Text style={styles.infoLabel}>Energy: High</Text>
          </View>

          <TouchableOpacity
            style={styles.button}
            onPress={() => goToScreen('export')}
          >
            <Text style={styles.buttonText}>Apply & Export →</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (screen === 'export') {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.centerContent}>
            <Text style={styles.largeEmoji}>🎉</Text>
            <Text style={styles.title}>Your video is ready!</Text>
            <Text style={styles.desc}>✨ Vibrant Pop applied</Text>

            <View style={styles.videoPreview}>
              <Text style={styles.videoEmoji}>✨</Text>
              <Text style={styles.videoText}>Video Ready</Text>
            </View>

            <TouchableOpacity
              style={styles.button}
              onPress={() => Alert.alert('✅ Video saved to your device!')}
            >
              <Text style={styles.buttonText}>💾 Save to Device</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, styles.buttonSecondary]}
              onPress={() => Alert.alert('📤 Sharing video...')}
            >
              <Text style={styles.buttonText}>📤 Share Video</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, styles.buttonSecondary]}
              onPress={() => {
                setSelectedFormat(null);
                setProgress(0);
                goToScreen('welcome');
              }}
            >
              <Text style={styles.buttonText}>Create Another</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F0F1A',
  },
  scroll: {
    padding: 24,
    paddingBottom: 40,
  },
  centerContent: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 40,
  },
  header: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A4A',
  },
  backBtn: {
    color: '#6C63FF',
    fontSize: 16,
    fontWeight: '600',
  },
  emoji: { fontSize: 64, marginBottom: 16 },
  largeEmoji: { fontSize: 72, marginBottom: 20 },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: '#FFF',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: '#8B8BA7',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
  },
  desc: {
    fontSize: 14,
    color: '#8B8BA7',
    marginBottom: 20,
    textAlign: 'center',
  },
  step: {
    fontSize: 12,
    color: '#6C63FF',
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  features: { gap: 12, marginBottom: 32 },
  feature: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#1A1A2E',
    padding: 14,
    borderRadius: 12,
  },
  featureIcon: { fontSize: 20 },
  featureText: { color: '#C8C8E8', fontSize: 14, flex: 1 },
  dropzone: {
    borderWidth: 2,
    borderColor: '#2A2A4A',
    borderStyle: 'dashed',
    borderRadius: 24,
    padding: 40,
    alignItems: 'center',
    backgroundColor: '#12122A',
    marginBottom: 24,
  },
  icon: { fontSize: 56, marginBottom: 12 },
  dropTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFF',
    marginBottom: 4,
  },
  dropSub: { fontSize: 13, color: '#5A5A7A' },
  button: {
    backgroundColor: '#6C63FF',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonDisabled: { backgroundColor: '#2A2A4A', opacity: 0.5 },
  buttonSecondary: {
    backgroundColor: '#1A1A2E',
    borderWidth: 1,
    borderColor: '#2A2A4A',
  },
  buttonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A2E',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 2,
    borderColor: '#2A2A4A',
  },
  cardSelected: {
    borderColor: '#6C63FF',
    backgroundColor: '#1E1E38',
  },
  cardEmoji: { fontSize: 32, marginRight: 12 },
  cardInfo: { flex: 1 },
  cardName: { fontSize: 16, fontWeight: '700', color: '#FFF', marginBottom: 4 },
  cardDesc: { fontSize: 13, color: '#8B8BA7' },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#3A3A5A',
    justifyContent: 'center',
    alignItems: 'center',
  },
  radioSelected: { borderColor: '#6C63FF' },
  radioDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#6C63FF',
  },
  progressBar: {
    height: 6,
    backgroundColor: '#2A2A4A',
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 20,
    width: '100%',
  },
  progressFill: { height: '100%', backgroundColor: '#6C63FF' },
  stepItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  stepDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#2A2A4A' },
  stepDotDone: { backgroundColor: '#4CAF50' },
  stepText: { color: '#4A4A6A', fontSize: 14, flex: 1 },
  check: { color: '#4CAF50', fontSize: 14 },
  templateCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A2E',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2A2A4A',
  },
  templateIcon: { fontSize: 32, marginRight: 12 },
  templateInfo: { flex: 1 },
  templateName: { fontSize: 14, fontWeight: '700', color: '#FFF', marginBottom: 4 },
  templateDesc: { fontSize: 12, color: '#8B8BA7' },
  aiPickBadge: { backgroundColor: '#6C63FF', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  aiPickText: { fontSize: 10, color: '#FFF', fontWeight: '700' },
  videoPreview: {
    width: 150,
    height: 260,
    backgroundColor: '#1A1A2E',
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 30,
    borderWidth: 1,
    borderColor: '#2A2A4A',
  },
  videoEmoji: { fontSize: 56, marginBottom: 10 },
  videoText: { color: '#FFF', fontSize: 14, fontWeight: '700', textAlign: 'center' },
  infoBox: {
    backgroundColor: '#1A1A2E',
    borderRadius: 12,
    padding: 12,
    marginBottom: 20,
  },
  infoLabel: { color: '#8B8BA7', fontSize: 13, marginBottom: 8 },
});
