import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../../store/useAppStore';
import { VideoFormat } from '../../types';

const { width } = Dimensions.get('window');

const FORMATS: Array<{
  id: VideoFormat;
  name: string;
  emoji: string;
  aspectRatio: string;
  duration: string;
  description: string;
  color: string;
}> = [
  {
    id: 'stories',
    name: 'Instagram Stories',
    emoji: '📸',
    aspectRatio: '9:16',
    duration: '15 sec',
    description: 'Vertical full-screen format. Great for personal moments & promotions.',
    color: '#E1306C',
  },
  {
    id: 'reels',
    name: 'Instagram Reels',
    emoji: '🎬',
    aspectRatio: '9:16',
    duration: '15–90 sec',
    description: 'Short-form vertical video. Best for reach and discovery.',
    color: '#833AB4',
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    emoji: '🎵',
    aspectRatio: '9:16',
    duration: '15–60 sec',
    description: 'Vertical video optimized for TikTok\'s algorithm and aesthetic.',
    color: '#010101',
  },
];

export default function FormatScreen() {
  const [selected, setSelected] = useState<VideoFormat | null>(null);
  const setFormat = useAppStore(s => s.setFormat);

  function handleContinue() {
    if (!selected) return;
    setFormat(selected);
    router.push('/(screens)/analyzing');
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.stepLabel}>Step 2 of 5</Text>
          <Text style={styles.title}>Choose Format</Text>
          <Text style={styles.description}>
            Where will you post this video? AI will optimize the template for your platform.
          </Text>
        </View>

        <View style={styles.cards}>
          {FORMATS.map((format) => {
            const isSelected = selected === format.id;
            return (
              <TouchableOpacity
                key={format.id}
                style={[styles.card, isSelected && styles.cardSelected]}
                onPress={() => setSelected(format.id)}
                activeOpacity={0.85}
              >
                <View style={styles.cardLeft}>
                  <View style={[styles.cardIcon, { backgroundColor: format.color + '22' }]}>
                    <Text style={styles.cardEmoji}>{format.emoji}</Text>
                  </View>
                  <View style={styles.cardInfo}>
                    <Text style={styles.cardName}>{format.name}</Text>
                    <Text style={styles.cardDescription}>{format.description}</Text>
                    <View style={styles.cardMeta}>
                      <View style={styles.metaTag}>
                        <Text style={styles.metaText}>{format.aspectRatio}</Text>
                      </View>
                      <View style={styles.metaTag}>
                        <Text style={styles.metaText}>{format.duration}</Text>
                      </View>
                    </View>
                  </View>
                </View>
                <View style={[styles.radioOuter, isSelected && styles.radioOuterSelected]}>
                  {isSelected && <View style={styles.radioInner} />}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        <TouchableOpacity
          style={[styles.continueButton, !selected && styles.continueButtonDisabled]}
          onPress={handleContinue}
          disabled={!selected}
          activeOpacity={0.85}
        >
          <Text style={styles.continueText}>Analyze with AI</Text>
          <Text style={styles.continueArrow}>→</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F0F1A' },
  content: { flex: 1, paddingHorizontal: 24, paddingVertical: 24, gap: 24 },
  header: { gap: 8 },
  stepLabel: { fontSize: 12, color: '#6C63FF', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1 },
  title: { fontSize: 28, fontWeight: '800', color: '#FFFFFF' },
  description: { fontSize: 14, color: '#8B8BA7', lineHeight: 22 },
  cards: { flex: 1, gap: 12 },
  card: {
    backgroundColor: '#1A1A2E',
    borderRadius: 16,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#2A2A4A',
  },
  cardSelected: {
    borderColor: '#6C63FF',
    backgroundColor: '#1E1E38',
  },
  cardLeft: { flex: 1, flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  cardIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardEmoji: { fontSize: 24 },
  cardInfo: { flex: 1, gap: 4 },
  cardName: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },
  cardDescription: { fontSize: 13, color: '#8B8BA7', lineHeight: 18 },
  cardMeta: { flexDirection: 'row', gap: 8, marginTop: 4 },
  metaTag: {
    backgroundColor: '#2A2A4A',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  metaText: { fontSize: 11, color: '#9B9BB7', fontWeight: '600' },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#3A3A5A',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 12,
  },
  radioOuterSelected: { borderColor: '#6C63FF' },
  radioInner: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#6C63FF' },
  continueButton: {
    backgroundColor: '#6C63FF',
    borderRadius: 16,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  continueButtonDisabled: { backgroundColor: '#2A2A4A' },
  continueText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  continueArrow: { color: '#FFFFFF', fontSize: 18 },
});
