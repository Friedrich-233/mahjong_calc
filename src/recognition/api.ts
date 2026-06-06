import type { RecognitionResult } from './types';

// Downscale the photo in the browser before upload: smaller payload, fewer
// vision tokens, lower latency. Long edge capped at ~1500px, re-encoded as JPEG.
const MAX_EDGE = 1500;
const JPEG_QUALITY = 0.85;

export const fileToResizedDataUrl = (
  file: File
): Promise<{ dataUrl: string; mediaType: string }> =>
  new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const longEdge = Math.max(img.width, img.height) || 1;
      const scale = Math.min(1, MAX_EDGE / longEdge);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx === null) {
        reject(new Error('Canvas 2D context is unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      resolve({
        dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY),
        mediaType: 'image/jpeg'
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not load the selected image'));
    };
    img.src = objectUrl;
  });

export const recognizeImage = async (
  file: File
): Promise<RecognitionResult> => {
  const { dataUrl, mediaType } = await fileToResizedDataUrl(file);
  const response = await fetch('/api/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl, media_type: mediaType })
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `Recognition failed (HTTP ${response.status})`;
    const raw =
      data && typeof data === 'object' && 'raw' in data
        ? String((data as { raw: unknown }).raw)
        : '';
    const message = raw ? `${error}: ${raw.slice(0, 800)}` : error;
    throw new Error(message);
  }
  return data as RecognitionResult;
};
