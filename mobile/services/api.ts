import axios from 'axios';
import { VideoFormat, VideoAnalysis, Template } from '../types';

// ── Base URL resolution ──────────────────────────────────────────────────────
// Production builds MUST provide EXPO_PUBLIC_API_URL. A local fallback is only
// allowed in development so that a physical/localhost dev server keeps working.
const RAW_API_URL = process.env.EXPO_PUBLIC_API_URL?.trim();
const DEV_FALLBACK_URL = 'http://localhost:3000';

function resolveBaseUrl(): string {
  if (RAW_API_URL) return RAW_API_URL;
  if (__DEV__) return DEV_FALLBACK_URL; // local fallback — development only
  return ''; // production without a configured URL → not usable
}

const BASE_URL = resolveBaseUrl();

/** True when a usable API base URL is available. */
export const isApiConfigured = BASE_URL.length > 0;

/** Human-readable reason shown to the user when the API is not configured. */
export const apiConfigError =
  'Сервер не настроен: задайте EXPO_PUBLIC_API_URL для production-сборки приложения.';

if (isApiConfigured) {
  console.log('[API] Connecting to:', BASE_URL);
} else {
  console.warn('[API] EXPO_PUBLIC_API_URL is not set — API calls are disabled in this build.');
}

function ensureConfigured(): void {
  if (!isApiConfigured) {
    throw new Error(apiConfigError);
  }
}

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
  ensureConfigured();

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
  ensureConfigured();
  const response = await api.post<AnalyzeResponse>('/video/analyze', { videoId, format });
  return response.data;
}

export async function processVideo(
  videoId: string,
  templateId: string,
  format: VideoFormat,
): Promise<ProcessResponse> {
  ensureConfigured();
  const response = await api.post<ProcessResponse>('/video/process', {
    videoId,
    templateId,
    format,
  });
  return response.data;
}

export function getVideoUrl(downloadPath: string): string {
  ensureConfigured();
  return `${BASE_URL}${downloadPath}`;
}
