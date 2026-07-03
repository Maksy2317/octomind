import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Alert,
} from 'react-native';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useVideoPlayer, VideoView } from 'expo-video';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../../store/useAppStore';

export default function ExportScreen() {
  const [isSaving, setIsSaving] = useState(false);
  const [savedToLibrary, setSavedToLibrary] = useState(false);
  const { processedVideoUrl, selectedFormat, selectedTemplate, reset } = useAppStore();

  const hasVideo = !!processedVideoUrl;

  // Player is created for the processed result. Hooks must run unconditionally,
  // so we pass the (possibly null) URL — expo-video renders nothing without a source.
  const player = useVideoPlayer(processedVideoUrl ?? '', (p) => {
    p.loop = true;
  });

  async function saveToLibrary() {
    // Guard: never attempt a download without a ready URL.
    if (!processedVideoUrl) {
      Alert.alert('Видео ещё не готово', 'Обработанное видео недоступно. Попробуйте создать его заново.');
      return;
    }

    setIsSaving(true);
    try {
      const permission = await MediaLibrary.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission needed', 'Allow access to save video to your library.');
        return;
      }

      // Download video to local cache first
      const filename = `ai-marketer-${Date.now()}.mp4`;
      const localPath = `${FileSystem.cacheDirectory}${filename}`;

      const download = await FileSystem.downloadAsync(processedVideoUrl, localPath);

      const asset = await MediaLibrary.createAssetAsync(download.uri);
      await MediaLibrary.createAlbumAsync('AI Marketer', asset, false);

      setSavedToLibrary(true);
    } catch (err: any) {
      Alert.alert('Save failed', err.message || 'Could not save to library.');
    } finally {
      setIsSaving(false);
    }
  }

  async function shareVideo() {
    // Guard: never attempt a download without a ready URL.
    if (!processedVideoUrl) {
      Alert.alert('Видео ещё не готово', 'Обработанное видео недоступно. Попробуйте создать его заново.');
      return;
    }

    try {
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) {
        Alert.alert('Sharing not available', 'Your device does not support sharing.');
        return;
      }

      const filename = `ai-marketer-${Date.now()}.mp4`;
      const localPath = `${FileSystem.cacheDirectory}${filename}`;
      const download = await FileSystem.downloadAsync(processedVideoUrl, localPath);

      await Sharing.shareAsync(download.uri, {
        mimeType: 'video/mp4',
        dialogTitle: 'Share your video',
      });
    } catch (err: any) {
      Alert.alert('Share failed', err.message || 'Could not share the video.');
    }
  }

  function handleStartOver() {
    reset();
    router.replace('/');
  }

  const formatEmoji: Record<string, string> = {
    stories: '📸',
    reels: '🎬',
    tiktok: '🎵',
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.successBadge}>
          <Text style={styles.successEmoji}>🎉</Text>
          <View>
            <Text style={styles.successTitle}>Your video is ready!</Text>
            <Text style={styles.successSubtitle}>
              {formatEmoji[selectedFormat!]} {selectedTemplate?.name} applied
            </Text>
          </View>
        </View>

        {/* Processed video */}
        <View style={styles.videoContainer}>
          {hasVideo ? (
            <VideoView
              style={StyleSheet.absoluteFill}
              player={player}
              contentFit="cover"
              nativeControls
            />
          ) : (
            <View style={styles.videoPlaceholder}>
              <Text style={styles.placeholderIcon}>⚠️</Text>
              <Text style={styles.placeholderText}>Видео недоступно</Text>
              <Text style={styles.placeholderSubtext}>Создайте его заново</Text>
            </View>
          )}
          <View style={styles.processedBadge}>
            <Text style={styles.processedBadgeText}>✨ Processed</Text>
          </View>
        </View>

        {/* Action buttons */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.primaryAction, savedToLibrary && styles.savedAction, !hasVideo && styles.actionDisabled]}
            onPress={saveToLibrary}
            disabled={!hasVideo || isSaving || savedToLibrary}
            activeOpacity={0.85}
          >
            <Text style={styles.actionIcon}>{savedToLibrary ? '✓' : '💾'}</Text>
            <Text style={styles.primaryActionText}>
              {isSaving ? 'Saving...' : savedToLibrary ? 'Saved to Library' : 'Save to Library'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.secondaryAction, !hasVideo && styles.actionDisabled]}
            onPress={shareVideo}
            disabled={!hasVideo}
            activeOpacity={0.85}
          >
            <Text style={styles.actionIcon}>📤</Text>
            <Text style={styles.secondaryActionText}>Share Video</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.startOverButton} onPress={handleStartOver}>
          <Text style={styles.startOverText}>Create Another Video</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F0F1A' },
  content: { flex: 1, paddingHorizontal: 24, paddingVertical: 16, gap: 20 },
  successBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#1A2A1A',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2A4A2A',
  },
  successEmoji: { fontSize: 32 },
  successTitle: { fontSize: 18, fontWeight: '700', color: '#FFFFFF' },
  successSubtitle: { fontSize: 13, color: '#6B9B6B', marginTop: 2 },
  videoContainer: {
    flex: 1,
    backgroundColor: '#1A1A2E',
    borderRadius: 20,
    overflow: 'hidden',
    alignSelf: 'center',
    width: '55%',
    maxHeight: 380,
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
  processedBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: '#6C63FF',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  processedBadgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  actions: { gap: 12 },
  primaryAction: {
    backgroundColor: '#6C63FF',
    borderRadius: 16,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  savedAction: { backgroundColor: '#2A4A2A' },
  actionDisabled: { opacity: 0.4 },
  actionIcon: { fontSize: 20 },
  primaryActionText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  secondaryAction: {
    backgroundColor: '#1A1A2E',
    borderRadius: 16,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: '#2A2A4A',
  },
  secondaryActionText: { color: '#C8C8E8', fontSize: 16, fontWeight: '600' },
  startOverButton: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  startOverText: { color: '#5A5A7A', fontSize: 14, fontWeight: '600' },
});
