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

export function buildAudioEnhanceFilters() {
  return 'highpass=f=80,afftdn=nf=-20,alimiter=limit=0.95,loudnorm=I=-14:TP=-1.5:LRA=11';
}

export async function extractThumbnail(inputPath, meta) {
  const duration = meta?.duration || 10;
  const seek = Math.max(0.5, duration * 0.35);
  const thumbName = `thumb-${uuidv4()}.jpg`;
  const thumbPath = path.join(config.processedDir, thumbName);

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(seek)
      .outputOptions(['-frames:v', '1', '-q:v', '2'])
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
 * Run enabled enhancement passes (each may re-encode once).
 * Order: stabilize → denoise → frame interp → cinematic grade
 */
export async function runVideoEnhancements(inputPath, modifications = {}, meta = {}) {
  const steps = [];
  let workingPath = inputPath;

  const runStep = async (enabled, fn, stepId) => {
    if (!enabled) return;
    const result = await fn(workingPath, meta);
    workingPath = result.outputPath;
    steps.push({ step: stepId, status: 'completed', message: result.label });
  };

  await runStep(modifications.stabilize, stabilizeVideo, 'stabilization');
  await runStep(
    modifications.denoiseSharpen !== false,
    (p) => denoiseAndSharpen(p),
    'denoise_sharpen'
  );
  await runStep(
    modifications.frameInterpolation,
    (p, m) => interpolateFrames(p, m),
    'frame_interpolation'
  );
  await runStep(
    modifications.styleTransfer,
    (p) => applyCinematicGrade(p),
    'style_transfer'
  );
  await runStep(modifications.hdrTone, (p) => applyHdrTone(p), 'hdr_tone');

  if (modifications.objectDetection) {
    steps.push({
      step: 'object_detection',
      status: 'planned',
      message:
        'Object segmentation/removal requires a dedicated GPU model — not enabled in local mode.',
    });
  }

  let thumbnail = null;
  if (modifications.generateThumbnail !== false) {
    try {
      const freshMeta = workingPath === inputPath ? meta : await extractMetadata(workingPath);
      thumbnail = await extractThumbnail(workingPath, freshMeta);
      if (thumbnail) {
        steps.push({
          step: 'thumbnail',
          status: 'completed',
          message: 'Auto-selected engagement thumbnail',
        });
      }
    } catch {
      // optional
    }
  }

  return {
    outputPath: workingPath,
    steps,
    thumbnail,
    audioEnhance: modifications.audioEnhance !== false,
  };
}
