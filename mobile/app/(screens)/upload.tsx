import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Alert, ActivityIndicator, Platform,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../../store/useAppStore';
import { uploadVideo } from '../../services/api';
import { ProgressBar } from '../../components/ui/ProgressBar';

export default function UploadScreen() {
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const setVideo = useAppStore(s => s.setVideo);

  async function pickFromLibrary() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Please allow access to your photo library.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      allowsEditing: false,
      quality: 1,
    });

    if (!result.canceled && result.assets[0]) {
      await handleUpload(result.assets[0].uri);
    }
  }

  async function pickFromFiles() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['video/mp4', 'video/quicktime', 'video/x-msvideo'],
      copyToCacheDirectory: true,
    });

    if (!result.canceled && result.assets[0]) {
      await handleUpload(result.assets[0].uri);
    }
  }

  async function handleUpload(uri: string) {
    setIsUploading(true);
    setUploadProgress(0);

    try {
      console.log('[Upload] Starting upload from:', uri);
      const response = await uploadVideo(uri, (progress) => {
        setUploadProgress(progress);
      });

      console.log('[Upload] Success:', response);
      setVideo(uri, response.videoId, response.size);
      router.push('/(screens)/format');
    } catch (error: any) {
      console.error('[Upload] Error:', error);
      Alert.alert(
        'Upload failed',
        error?.response?.data?.error || error.message || 'Please try again.',
      );
    } finally {
      setIsUploading(false);
    }
  }

  if (isUploading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.uploadingContainer}>
          <ActivityIndicator size="large" color="#6C63FF" />
          <Text style={styles.uploadingTitle}>Uploading your video...</Text>
          <ProgressBar progress={uploadProgress} />
          <Text style={styles.uploadingPercent}>{uploadProgress}%</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.stepLabel}>Step 1 of 5</Text>
          <Text style={styles.title}>Upload Your Video</Text>
          <Text style={styles.description}>
            Select a video from your library or files. We support MP4, MOV, and AVI up to 200MB.
          </Text>
        </View>

        <View style={styles.dropZone}>
          <Text style={styles.dropIcon}>🎥</Text>
          <Text style={styles.dropTitle}>Add your video</Text>
          <Text style={styles.dropSubtitle}>MP4, MOV, AVI · Max 200MB</Text>
        </View>

        <View style={styles.actions}>
          <TouchableOpacity style={styles.primaryButton} onPress={pickFromLibrary} activeOpacity={0.85}>
            <Text style={styles.primaryButtonIcon}>📷</Text>
            <Text style={styles.primaryButtonText}>Choose from Library</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryButton} onPress={pickFromFiles} activeOpacity={0.85}>
            <Text style={styles.secondaryButtonIcon}>📁</Text>
            <Text style={styles.secondaryButtonText}>Browse Files</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F0F1A' },
  content: { flex: 1, paddingHorizontal: 24, justifyContent: 'space-between', paddingVertical: 24 },
  header: { gap: 8 },
  stepLabel: { fontSize: 12, color: '#6C63FF', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1 },
  title: { fontSize: 28, fontWeight: '800', color: '#FFFFFF' },
  description: { fontSize: 14, color: '#8B8BA7', lineHeight: 22 },
  dropZone: {
    flex: 1,
    marginVertical: 32,
    borderRadius: 24,
    borderWidth: 2,
    borderColor: '#2A2A4A',
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#12122A',
  },
  dropIcon: { fontSize: 56 },
  dropTitle: { fontSize: 18, fontWeight: '700', color: '#FFFFFF' },
  dropSubtitle: { fontSize: 13, color: '#5A5A7A' },
  actions: { gap: 12 },
  primaryButton: {
    backgroundColor: '#6C63FF',
    borderRadius: 16,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  primaryButtonIcon: { fontSize: 20 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  secondaryButton: {
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
  secondaryButtonIcon: { fontSize: 20 },
  secondaryButtonText: { color: '#C8C8E8', fontSize: 16, fontWeight: '600' },
  uploadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 20,
    paddingHorizontal: 40,
  },
  uploadingTitle: { fontSize: 18, fontWeight: '700', color: '#FFFFFF' },
  uploadingPercent: { fontSize: 14, color: '#8B8BA7' },
});
