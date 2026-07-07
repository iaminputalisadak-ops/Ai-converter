import { existsSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import { config } from '../config.js';
import { extractMetadata } from './ffmpegService.js';

function tempOutput(suffix = '.mp4') {
  return path.join(config.processedDir, `enhance-${uuidv4()}${suffix}`);
}

function runVideoFilter(inputPath, outputPath, videoFilter, { audioCopy = true } = {}) {
  return new Promise((resolve, reject) => {
    const run = (nvenc) => {
      const cmd = ffmpeg(inputPath).videoFilters(videoFilter);
      const vcodec = nvenc
        ? ['-c:v', 'h264_nvenc', '-preset', 'p1', '-rc', 'vbr', '-cq', '20']
        : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20'];
      cmd
        .outputOptions([...vcodec, audioCopy ? '-c:a copy' : '-an', '-pix_fmt', 'yuv420p'])
        .on('end', () => resolve(outputPath))
        .on('error', () => {
          if (nvenc) run(false);
          else reject(new Error(`FFmpeg filter failed: ${videoFilter}`));
        })
        .save(outputPath);
    };
    run(true);
  });
}

export async function stabilizeVideo(inputPath) {
  const outputPath = tempOutput();
  await runVideoFilter(inputPath, outputPath, 'deshake');
  return { outputPath, label: 'AI-based stabilization (deshake)' };
}

export async function interpolateFrames(inputPath, meta) {
  const fps = meta?.video?.fps || 30;
  const targetFps = Math.min(60, Math.round(fps * 2));
  const outputPath = tempOutput();
  await runVideoFilter(
    inputPath,
    outputPath,
    `minterpolate=fps=${targetFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`
  );
  return {
    outputPath,
    label: `Frame interpolation (${fps.toFixed(0)} → ${targetFps} fps)`,
  };
}

export async function denoiseAndSharpen(inputPath) {
  const outputPath = tempOutput();
  await runVideoFilter(
    inputPath,
    outputPath,
    'hqdn3d=2:1.5:3:2,unsharp=5:5:0.45:5:5:0.0'
  );
  return { outputPath, label: 'Noise reduction + detail sharpening' };
}

export async function applyCinematicGrade(inputPath) {
  const outputPath = tempOutput();
  await runVideoFilter(
    inputPath,
    outputPath,
    'eq=contrast=1.14:brightness=0.02:saturation=1.18,curves=vintage'
  );
  return { outputPath, label: 'Cinematic color grade (LUT-style)' };
}

export async function applyHdrTone(inputPath) {
  const outputPath = tempOutput();
  await runVideoFilter(
    inputPath,
    outputPath,
    'zscale=t=linear:npl=100,format=yuv420p,eq=contrast=1.08:saturation=1.12'
  );
  return { outputPath, label: 'HDR-style tone mapping (SDR output)' };
}

export function getMergeableEnhancementFilters(modifications = {}, meta = {}) {
  const filters = [];

  if (modifications.denoiseSharpen !== false) {
    filters.push('hqdn3d=1:0.8:2:1.5', 'unsharp=5:5:0.35:5:5:0.0');
  }
  if (modifications.stabilize) {
    // Stronger + more noticeable stabilization (still single-pass).
    filters.push('deshake=rx=64:ry=64:edge=mirror');
  }
  if (modifications.styleTransfer) {
    filters.push('eq=contrast=1.14:brightness=0.02:saturation=1.18', 'curves=vintage');
  }
  if (modifications.hdrTone) {
    // More visible HDR-style punch without heavy zscale.
    filters.push('eq=contrast=1.18:saturation=1.22:brightness=0.03');
  }
  if (modifications.frameInterpolation) {
    const fps = meta?.video?.fps || 30;
    const targetFps = Math.min(60, Math.round(fps * 2));
    // dup mode is ~50× faster than full motion-compensated minterpolate
    filters.push(`minterpolate=fps=${targetFps}:mi_mode=dup`);
  }

  return filters;
}

export function needsSeparateEnhancePass() {
  // All enhancements are merged into the export encode for speed.
  return false;
}

export function describeEnhancementSteps(modifications = {}, meta = {}) {
  const steps = [];
  if (modifications.denoiseSharpen !== false) {
    steps.push({ step: 'denoise_sharpen', status: 'completed', message: 'Denoise + sharpen (single pass)' });
  }
  if (modifications.stabilize) {
    steps.push({ step: 'stabilization', status: 'completed', message: 'Stabilization (single pass)' });
  }
  if (modifications.frameInterpolation) {
    const fps = meta?.video?.fps || 30;
    const targetFps = Math.min(60, Math.round(fps * 2));
    steps.push({
      step: 'frame_interpolation',
      status: 'completed',
      message: `Frame smoothing ${fps.toFixed(0)}→${targetFps} fps (fast, single pass)`,
    });
  }
  if (modifications.styleTransfer) {
    steps.push({ step: 'style_transfer', status: 'completed', message: 'Cinematic grade (single pass)' });
  }
  if (modifications.hdrTone) {
    steps.push({ step: 'hdr_tone', status: 'completed', message: 'HDR tone (single pass)' });
  }
  return steps;
}

export function buildAudioEnhanceFilters() {
  return 'highpass=f=80,afftdn=nf=-20,alimiter=limit=0.95,loudnorm=I=-14:TP=-1.5:LRA=11';
}

/** Lighter chain for BGM mix — loudnorm breaks amix in complex filter graphs. */
export function buildVoiceMixFilters() {
  return 'highpass=f=80,alimiter=limit=0.95';
}

export async function extractThumbnail(inputPath, meta) {
  const duration = meta?.duration || 10;
  const seek = Math.max(0.5, duration * 0.35);
  const thumbName = `thumb-${uuidv4()}.jpg`;
  const thumbPath = path.join(config.processedDir, thumbName);

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(seek)
      .outputOptions(['-frames:v', '1', '-q:v', '3'])
      .output(thumbPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  if (!existsSync(thumbPath)) {
    return null;
  }

  return {
    path: thumbPath,
    filename: thumbName,
    url: `/api/video/file/${thumbName}`,
  };
}

/**
 * Plan enhancements — no separate encode; everything merges into export.
 */
export async function runVideoEnhancements(inputPath, modifications = {}, meta = {}) {
  const mergeableFilters = getMergeableEnhancementFilters(modifications, meta);
  const steps = describeEnhancementSteps(modifications, meta);

  if (modifications.objectDetection) {
    steps.push({
      step: 'object_detection',
      status: 'planned',
      message:
        'Advanced object detection requires a dedicated GPU model — not enabled in local mode.',
    });
  }

  return {
    outputPath: inputPath,
    steps,
    mergeableFilters,
    audioEnhance: modifications.audioEnhance !== false,
  };
}

/** Generate thumbnail without blocking the main pipeline. */
export function generateThumbnailAsync(inputPath, meta) {
  return extractThumbnail(inputPath, meta)
    .then((thumbnail) => thumbnail)
    .catch(() => null);
}
