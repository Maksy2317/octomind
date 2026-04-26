import { create } from 'zustand';
import { AppState, VideoFormat, VideoAnalysis, Template } from '../types';

const initialState = {
  videoUri: null,
  videoId: null,
  videoSize: null,
  selectedFormat: null,
  analysis: null,
  isAnalyzing: false,
  templates: [],
  selectedTemplate: null,
  isProcessing: false,
  processedVideoUrl: null,
};

export const useAppStore = create<AppState>((set) => ({
  ...initialState,

  setVideo: (uri: string, id: string, size: number) =>
    set({ videoUri: uri, videoId: id, videoSize: size }),

  setFormat: (format: VideoFormat) =>
    set({ selectedFormat: format }),

  setAnalysis: (analysis: VideoAnalysis, templates: Template[]) =>
    set({ analysis, templates, isAnalyzing: false }),

  setSelectedTemplate: (template: Template) =>
    set({ selectedTemplate: template }),

  setProcessing: (processing: boolean) =>
    set({ isProcessing: processing }),

  setProcessedVideo: (url: string) =>
    set({ processedVideoUrl: url, isProcessing: false }),

  reset: () => set(initialState),
}));
