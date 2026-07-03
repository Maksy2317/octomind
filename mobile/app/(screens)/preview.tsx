import React from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Alert, ScrollView, ActivityIndicator,
} from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../../store/useAppStore';
import { processVideo, getVideoUrl } from '../../services/api';

export default function PreviewScreen() {
  const store = useAppStore();

  const hasSource = !!store.videoUri;

  // Muted, looping preview of the original selected video.
  const player = useVideoPlayer(store.videoUri ?? '', (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });

  async function handleProcess() {
    if (!store.videoId || !store.selectedTemplate || !store.selectedFormat) return;

    store.setProcessing(true);

    try {
      const result = await processVideo(
        store.videoId,
        store.selectedTemplate.id,
        store.selectedFormat,
      );

      const fullUrl = getVideoUrl(result.downloadUrl);
      store.setProcessedVideo(fullUrl);
      router.push('/(screens)/export');
    } catch (error: any) {
      store.setProcessing(false);
      Alert.alert(
        'Processing failed',
        error?.response?.data?.error || error.message || 'Please try again.',
      );
    }
  }

  const formatLabels: Record<string, string> = {
    stories: 'Instagram Stories',
    reels: 'Instagram Reels',
    tiktok: 'TikTok',
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.stepLabel}>Step 4 of 5</Text>
          <Text style={styles.title}>Preview</Text>
        </View>

        {/* Original video preview */}
        <View style={styles.videoContainer}>
          {hasSource ? (
            <VideoView
              style={StyleSheet.absoluteFill}
              player={player}
              contentFit="cover"
              nativeControls={false}
            />
          ) : (
            <View style={styles.videoPlaceholder}>
              <Text style={styles.placeholderIcon}>🎥</Text>
              <Text style={styles.placeholderText}>No video</Text>
              <Text style={styles.placeholderSubtext}>Go back to upload</Text>
            </View>
          )}
          <View style={styles.videoLabel}>
            <Text style={styles.videoLabelText}>Original</Text>
          </View>
        </View>

        {/* Selected template info */}
        <View style={styles.templateCard}>
          <View style={styles.templateCardRow}>
            <View style={styles.templateInfo}>
              <Text style={styles.templateLabel}>Selected Template</Text>
              <Text style={styles.templateName}>{store.selectedTemplate?.name}</Text>
              <Text style={styles.templateDescription}>{store.selectedTemplate?.description}</Text>
            </View>
            <TouchableOpacity
              style={styles.changeButton}
              onPress={() => router.back()}
            >
              <Text style={styles.changeText}>Change</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Format info */}
        <View style={styles.infoRow}>
          <InfoItem icon="📱" label="Format" value={formatLabels[store.selectedFormat!] || store.selectedFormat!} />
          <InfoItem icon="📐" label="Aspect Ratio" value="9:16 (1080×1920)" />
          {store.analysis && (
            <InfoItem icon="⚡" label="Energy" value={store.analysis.energy} />
          )}
        </View>

        {/* AI analysis summary */}
        {store.analysis && (
          <View style={styles.analysisCard}>
            <Text style={styles.analysisTitle}>AI Analysis</Text>
            <View style={styles.analysisTags}>
              {store.analysis.tags.map(tag => (
                <View key={tag} style={styles.tag}>
                  <Text style={styles.tagText}>{tag}</Text>
                </View>
              ))}
            </View>
            <Text style={styles.analysisMood}>Mood: {store.analysis.mood}</Text>
          </View>
        )}
      </ScrollView>

      <View style={styles.footer}>
        {store.isProcessing ? (
          <View style={styles.processingContainer}>
            <ActivityIndicator color="#6C63FF" />
            <Text style={styles.processingText}>Applying template with FFmpeg...</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.processButton}
            onPress={handleProcess}
            activeOpacity={0.85}
          >
            <Text style={styles.processText}>Apply Template & Export</Text>
            <Text style={styles.processArrow}>→</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

function InfoItem({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={styles.infoItem}>
      <Text style={styles.infoIcon}>{icon}</Text>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F0F1A' },
  scroll: { padding: 24, gap: 20 },
  header: { gap: 8 },
  stepLabel: { fontSize: 12, color: '#6C63FF', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1 },
  title: { fontSize: 28, fontWeight: '800', color: '#FFFFFF' },
  videoContainer: {
    aspectRatio: 9 / 16,
    backgroundColor: '#1A1A2E',
    borderRadius: 20,
    overflow: 'hidden',
    alignSelf: 'center',
    width: '55%',
    position: 'relative',
  },
  videoPlaceholder: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1A1A2E',
    gap: 8,
  },
  placeholderIcon: { fontSize: 56 },
  placeholderText: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },
  placeholderSubtext: { fontSize: 12, color: '#5A5A7A' },
  videoLabel: {
    position: 'absolute',
    top: 10,
    left: 10,
    backgroundColor: '#00000088',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  videoLabelText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600' },
  templateCard: {
    backgroundColor: '#1A1A2E',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2A2A4A',
  },
  templateCardRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  templateInfo: { flex: 1, gap: 4 },
  templateLabel: { fontSize: 11, color: '#5A5A7A', textTransform: 'uppercase', letterSpacing: 0.5 },
  templateName: { fontSize: 18, fontWeight: '700', color: '#FFFFFF' },
  templateDescription: { fontSize: 13, color: '#8B8BA7', lineHeight: 18 },
  changeButton: {
    backgroundColor: '#2A2A4A',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  changeText: { color: '#9B9BCC', fontSize: 13, fontWeight: '600' },
  infoRow: { flexDirection: 'row', gap: 10 },
  infoItem: {
    flex: 1,
    backgroundColor: '#1A1A2E',
    borderRadius: 12,
    padding: 12,
    alignItems: 'center',
    gap: 4,
  },
  infoIcon: { fontSize: 18 },
  infoLabel: { fontSize: 10, color: '#5A5A7A', textTransform: 'uppercase' },
  infoValue: { fontSize: 12, color: '#FFFFFF', fontWeight: '600', textAlign: 'center' },
  analysisCard: {
    backgroundColor: '#1A1A2E',
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  analysisTitle: { fontSize: 14, fontWeight: '700', color: '#FFFFFF' },
  analysisTags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { backgroundColor: '#2A2A4A', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  tagText: { fontSize: 12, color: '#9B9BCC' },
  analysisMood: { fontSize: 13, color: '#8B8BA7' },
  footer: { paddingHorizontal: 24, paddingBottom: 24, paddingTop: 12 },
  processingContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    padding: 16,
  },
  processingText: { color: '#8B8BA7', fontSize: 14 },
  processButton: {
    backgroundColor: '#6C63FF',
    borderRadius: 16,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  processText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  processArrow: { color: '#FFFFFF', fontSize: 18 },
});
