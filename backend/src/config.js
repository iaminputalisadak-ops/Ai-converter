import { mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  uploadDir: path.resolve(process.env.UPLOAD_DIR || './uploads'),
  processedDir: path.resolve(process.env.PROCESSED_DIR || './processed'),
  watermarkPath: path.resolve(process.env.WATERMARK_PATH || './assets/watermark.png'),
  platformId: process.env.PLATFORM_ID || 'converter-platform',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  assetsDir: path.join(__dirname, '..', 'assets'),
  aiUpscaleUrl: process.env.AI_UPSCALE_URL || '',
  realesrganBin: process.env.REALESRGAN_BIN || '',
};

export async function ensureDirectories() {
  await mkdir(config.uploadDir, { recursive: true });
  await mkdir(config.processedDir, { recursive: true });
  await mkdir(config.assetsDir, { recursive: true });
  await mkdir(path.join(config.assetsDir, 'music'), { recursive: true });
}
