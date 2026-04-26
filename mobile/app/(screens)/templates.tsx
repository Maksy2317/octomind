import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  FlatList, Image, Dimensions,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppStore } from '../../store/useAppStore';
import { Template } from '../../types';

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - 24 * 2 - 12) / 2;

export default function TemplatesScreen() {
  const { templates, analysis, selectedTemplate, setSelectedTemplate } = useAppStore();
  const [hovered, setHovered] = useState<string | null>(null);

  function handleSelect(template: Template) {
    setSelectedTemplate(template);
  }

  function handleContinue() {
    if (!selectedTemplate) return;
    router.push('/(screens)/preview');
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.stepLabel}>Step 3 of 5</Text>
        <Text style={styles.title}>Choose Template</Text>
        {analysis && (
          <View style={styles.analysisChips}>
            <Text style={styles.analysisLabel}>Detected: </Text>
            {analysis.tags.slice(0, 3).map(tag => (
              <View key={tag} style={styles.chip}>
                <Text style={styles.chipText}>{tag}</Text>
              </View>
            ))}
            <View style={[styles.chip, styles.moodChip]}>
              <Text style={styles.chipText}>{analysis.mood}</Text>
            </View>
          </View>
        )}
      </View>

      <FlatList
        data={templates}
        keyExtractor={item => item.id}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.list}
        scrollEnabled={true}
        showsVerticalScrollIndicator={false}
        renderItem={({ item, index }) => {
          const isSelected = selectedTemplate?.id === item.id;
          const isTopPick = index === 0;
          return (
            <TouchableOpacity
              style={[styles.card, isSelected && styles.cardSelected]}
              onPress={() => handleSelect(item)}
              activeOpacity={0.85}
            >
              {isTopPick && (
                <View style={styles.topPickBadge}>
                  <Text style={styles.topPickText}>✨ AI Pick</Text>
                </View>
              )}
              <Image
                source={{ uri: item.thumbnail }}
                style={styles.thumbnail}
                resizeMode="cover"
              />
              <View style={styles.cardBody}>
                <Text style={styles.cardName}>{item.name}</Text>
                <Text style={styles.cardDescription} numberOfLines={2}>
                  {item.description}
                </Text>
              </View>
              {isSelected && (
                <View style={styles.selectedOverlay}>
                  <Text style={styles.selectedCheck}>✓</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        }}
      />

      <View style={styles.footer}>
        <TouchableOpacity
          style={[styles.continueButton, !selectedTemplate && styles.continueButtonDisabled]}
          onPress={handleContinue}
          disabled={!selectedTemplate}
          activeOpacity={0.85}
        >
          <Text style={styles.continueText}>
            {selectedTemplate ? `Apply "${selectedTemplate.name}"` : 'Select a template'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F0F1A' },
  header: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 16, gap: 8 },
  stepLabel: { fontSize: 12, color: '#6C63FF', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 1 },
  title: { fontSize: 28, fontWeight: '800', color: '#FFFFFF' },
  analysisChips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  analysisLabel: { fontSize: 12, color: '#5A5A7A' },
  chip: { backgroundColor: '#1E1E38', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  moodChip: { backgroundColor: '#2A1E38' },
  chipText: { fontSize: 11, color: '#9B9BCC', fontWeight: '600' },
  list: { paddingHorizontal: 24, paddingBottom: 24 },
  row: { gap: 12, marginBottom: 12 },
  card: {
    width: CARD_WIDTH,
    backgroundColor: '#1A1A2E',
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#2A2A4A',
  },
  cardSelected: { borderColor: '#6C63FF' },
  thumbnail: { width: '100%', height: CARD_WIDTH * 1.4, backgroundColor: '#2A2A4A' },
  cardBody: { padding: 10, gap: 4 },
  cardName: { fontSize: 13, fontWeight: '700', color: '#FFFFFF' },
  cardDescription: { fontSize: 11, color: '#6B6B8B', lineHeight: 16 },
  topPickBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    zIndex: 10,
    backgroundColor: '#6C63FF',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  topPickText: { fontSize: 10, color: '#FFFFFF', fontWeight: '700' },
  selectedOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#6C63FF44',
    justifyContent: 'center',
    alignItems: 'center',
  },
  selectedCheck: { fontSize: 40, color: '#FFFFFF', fontWeight: '800' },
  footer: { paddingHorizontal: 24, paddingBottom: 24, paddingTop: 12 },
  continueButton: {
    backgroundColor: '#6C63FF',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
  },
  continueButtonDisabled: { backgroundColor: '#2A2A4A' },
  continueText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});
