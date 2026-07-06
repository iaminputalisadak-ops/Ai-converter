import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..');

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  uploadDir: path.resolve(backendRoot, process.env.UPLOAD_DIR || 'uploads'),
  processedDir: path.resolve(backendRoot, process.env.PROCESSED_DIR || 'processed'),
  watermarkPath: path.resolve(
    backendRoot,
    process.env.WATERMARK_PATH || 'assets/watermark.png'
  ),
  platformId: process.env.PLATFORM_ID || 'converter-platform',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  assetsDir: path.join(backendRoot, 'assets'),
  aiUpscaleUrl: process.env.AI_UPSCALE_URL || '',
  realesrganBin: process.env.REALESRGAN_BIN || '',
};

async function ensureWatermark() {
  if (existsSync(config.watermarkPath)) return;

  const font =
    process.platform === 'win32'
      ? 'C\\:/Windows/Fonts/arial.ttf'
      : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

  const drawtext = `drawtext=fontfile='${font}':text='${config.platformId}':fontsize=20:fontcolor=white@0.85:x=W-tw-20:y=H-th-20`;

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black@0.35:s=220x48',
      '-vf',
      drawtext,
      '-frames:v',
      '1',
      config.watermarkPath,
    ],
    { timeout: 30000 }
  );
}

async function ensureDefaultMusic() {
  const musicDir = path.join(config.assetsDir, 'music');
  const defaultTrack = path.join(musicDir, 'free-ambient.mp3');
  if (existsSync(defaultTrack)) return;

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=196:duration=45',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=247:duration=45',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=294:duration=45',
      '-filter_complex',
      '[0:a][1:a][2:a]amix=inputs=3:duration=longest,volume=0.18,afade=t=in:st=0:d=3,afade=t=out:st=42:d=3',
      '-c:a',
      'libmp3lame',
      '-q:a',
      '4',
      defaultTrack,
    ],
    { timeout: 60000 }
  );
}

export async function ensureDirectories() {
  await mkdir(config.uploadDir, { recursive: true });
  await mkdir(config.processedDir, { recursive: true });
  await mkdir(config.assetsDir, { recursive: true });
  await mkdir(path.join(config.assetsDir, 'music'), { recursive: true });
  await mkdir(path.dirname(config.watermarkPath), { recursive: true });

  try {
    await ensureWatermark();
  } catch (err) {
    console.warn('Could not generate default watermark:', err.message);
  }

  try {
    await ensureDefaultMusic();
  } catch (err) {
    console.warn('Could not generate default music track:', err.message);
  }
}
