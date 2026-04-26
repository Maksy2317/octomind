import axios from 'axios';
import { VideoFormat, VideoAnalysis, Template } from '../types';

// Get API URL from environment or use default
const BASE_URL = process.env.EXPO_PUBLIC_API_URL?.trim() || 'http://192.168.1.12:3000';

console.log('[API] Connecting to:', BASE_URL);

const api = axios.create({
  baseURL: `${BASE_URL}/api`,
  timeout: 120_000,
});

export interface UploadResponse {
  videoId: string;
  filename: string;
  size: number;
}

export interface AnalyzeResponse {
  analysis: VideoAnalysis;
  templates: Template[];
}

export interface ProcessResponse {
  outputVideoId: string;
  downloadUrl: string;
}

export async function uploadVideo(
  uri: string,
  onProgress?: (progress: number) => void,
): Promise<UploadResponse> {
  const formData = new FormData();

  // For React Native/Expo, use proper blob format
  const response = await fetch(uri);
  const blob = await response.blob();

  formData.append('video', blob, 'video.mp4');

  const uploadApi = axios.create({
    baseURL: `${BASE_URL}/api`,
    timeout: 300_000,
  });

  const res = await uploadApi.post<UploadResponse>('/video/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (event) => {
      if (event.total && onProgress) {
        onProgress(Math.round((event.loaded * 100) / event.total));
      }
    },
  });

  return res.data;
}

export async function analyzeVideo(
  videoId: string,
  format: VideoFormat,
): Promise<AnalyzeResponse> {
  const response = await api.post<AnalyzeResponse>('/video/analyze', { videoId, format });
  return response.data;
}

export async function processVideo(
  videoId: string,
  templateId: string,
  format: VideoFormat,
): Promise<ProcessResponse> {
  const response = await api.post<ProcessResponse>('/video/process', {
    videoId,
    templateId,
    format,
  });
  return response.data;
}

export function getVideoUrl(downloadPath: string): string {
  return `${BASE_URL}${downloadPath}`;
}
