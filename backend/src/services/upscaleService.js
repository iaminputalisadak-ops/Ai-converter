import { existsSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { extractMetadata } from './ffmpegService.js';

const execFileAsync = promisify(execFile);

export const TARGET_PRESETS = {
  '2x': {
    label: '2× source resolution',
    compute: (w, h) => ({
      width: roundEven(w * 2),
      height: roundEven(h * 2),
    }),
  },
  '4k': {
    label: '4K (3840×2160)',
    compute: (w, h) => fitWithin(w, h, 3840, 2160),
  },
  '8k': {
    label: '8K (7680×4320)',
    compute: (w, h) => fitWithin(w, h, 7680, 4320),
  },
};

function roundEven(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

function fitWithin(width, height, maxWidth, maxHeight) {
  const scale = Math.min(maxWidth / width, maxHeight / height);
  return {
    width: roundEven(width * scale),
    height: roundEven(height * scale),
  };
}

export function computeUpscaleTarget(sourceWidth, sourceHeight, target = '4k') {
  const preset = TARGET_PRESETS[target];
  if (!preset) {
    throw new Error(`Unknown upscale target "${target}".`);
  }
  return preset.compute(sourceWidth, sourceHeight);
}

function buildUpscaleLabel(method, source, target) {
  const src = `${source.width}×${source.height}`;
  const dst = `${target.width}×${target.height}`;

  if (method === 'realesrgan') {
    return `AI-upscaled (Real-ESRGAN) from ${src} to ${dst}`;
  }

  if (method === 'realesrgan+ffmpeg') {
    return `AI-upscaled (Real-ESRGAN + FFmpeg) from ${src} to ${dst}`;
  }

  if (method === 'ffmpeg_lanczos' || method === 'ffmpeg_cuda') {
    return `Fast upscale (FFmpeg${method === 'ffmpeg_cuda' ? ' GPU' : ''} Lanczos) from ${src} to ${dst} — quick, not AI-enhanced`;
  }

  return `Enhanced upscale from ${src} to ${dst}`;
}

async function tryRealesrganService(inputPath, outputPath, scale) {
  if (!config.aiUpscaleUrl) return null;

  const buffer = await readFileBuffer(inputPath);
  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: 'video/mp4' }), path.basename(inputPath));
  formData.append('scale', String(scale));

  const response = await fetch(`${config.aiUpscaleUrl}/upscale`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Real-ESRGAN service failed: ${detail}`);
  }

  const outputBuffer = Buffer.from(await response.arrayBuffer());
  await writeFileBuffer(outputPath, outputBuffer);
  return 'realesrgan';
}

async function readFileBuffer(filePath) {
  const { readFile } = await import('fs/promises');
  return readFile(filePath);
}

async function writeFileBuffer(filePath, buffer) {
  const { writeFile } = await import('fs/promises');
  await writeFile(filePath, buffer);
}

async function tryRealesrganCli(inputPath, outputPath, scale) {
  if (!config.realesrganBin || !existsSync(config.realesrganBin)) return null;

  const framesDir = path.join(config.uploadDir, `frames-${uuidv4()}`);
  const upscaledDir = path.join(config.uploadDir, `upscaled-${uuidv4()}`);
  const { mkdir, rm } = await import('fs/promises');

  await mkdir(framesDir, { recursive: true });
  await mkdir(upscaledDir, { recursive: true });

  try {
    await runFfmpegCommand(inputPath, framesDir, '%06d.png', [
      '-vf',
      'format=rgb24',
    ]);

    await execFileAsync(config.realesrganBin, [
      '-i',
      framesDir,
      '-o',
      upscaledDir,
      '-s',
      String(scale),
      '-f',
      'png',
    ]);

    const meta = await extractMetadata(inputPath);
    const fps = meta.video?.fps || 30;

    await runFfmpegEncodeFromFrames(upscaledDir, outputPath, fps, inputPath);
    return 'realesrgan';
  } finally {
    await rm(framesDir, { recursive: true, force: true });
    await rm(upscaledDir, { recursive: true, force: true });
  }
}

function runFfmpegCommand(inputPath, outputPattern, pattern, extraInputArgs = []) {
  return new Promise((resolve, reject) => {
    const output = path.join(outputPattern, pattern);
    ffmpeg(inputPath)
      .outputOptions(extraInputArgs)
      .output(output)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function runFfmpegEncodeFromFrames(framesDir, outputPath, fps, audioSourcePath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(framesDir, '%06d.png'))
      .inputOptions([`-framerate ${fps}`])
      .input(audioSourcePath)
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 18',
        '-pix_fmt yuv420p',
        '-c:a copy',
        '-shortest',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function upscaleWithFfmpeg(inputPath, outputPath, targetWidth, targetHeight, { useGpu = false } = {}) {
  return new Promise((resolve, reject) => {
    const run = (gpuScale, nvenc) => {
      const chain = ffmpeg(inputPath);
      if (gpuScale) {
        chain.videoFilters([`scale_cuda=${targetWidth}:${targetHeight}`]);
      } else {
        chain.videoFilters([
          `scale=${targetWidth}:${targetHeight}:flags=lanczos`,
          'unsharp=5:5:0.6:5:5:0.0',
        ]);
      }

      const codec = nvenc
        ? ['-c:v', 'h264_nvenc', '-preset', 'p1', '-rc', 'vbr', '-cq', '19']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18'];

      chain
        .outputOptions([...codec, '-c:a', 'copy', '-pix_fmt', 'yuv420p'])
        .output(outputPath)
        .on('end', () => resolve(gpuScale ? 'ffmpeg_cuda' : 'ffmpeg_lanczos'))
        .on('error', () => {
          if (nvenc) {
            run(gpuScale, false);
            return;
          }
          if (gpuScale) {
            run(false, false);
            return;
          }
          reject(new Error('FFmpeg upscale failed'));
        })
        .run();
    };
    run(useGpu, true);
  });
}

function inferScaleFactor(sourceWidth, targetWidth, { gpuFast = false } = {}) {
  const ratio = targetWidth / sourceWidth;
  if (gpuFast && ratio > 2) return 2;
  if (ratio <= 2) return 2;
  if (ratio <= 4) return 4;
  return 4;
}

export async function upscaleVideo(inputPath, options = {}) {
  const { target = '4k', mode = 'ai', gpuAvailable = false } = options;
  const preset = TARGET_PRESETS[target];

  if (!preset) {
    throw new Error(`Unknown upscale target "${target}". Use: ${Object.keys(TARGET_PRESETS).join(', ')}`);
  }

  const sourceMeta = await extractMetadata(inputPath);
  const sourceWidth = sourceMeta.video?.width;
  const sourceHeight = sourceMeta.video?.height;

  if (!sourceWidth || !sourceHeight) {
    throw new Error('Could not read source video dimensions for upscaling.');
  }

  const targetDims = preset.compute(sourceWidth, sourceHeight);

  if (targetDims.width <= sourceWidth && targetDims.height <= sourceHeight) {
    return {
      skipped: true,
      reason: 'Source resolution already meets or exceeds the selected target.',
      source: { width: sourceWidth, height: sourceHeight },
      target: targetDims,
      outputPath: inputPath,
    };
  }

  const outputFilename = `upscaled-${uuidv4()}.mp4`;
  const outputPath = path.join(config.processedDir, outputFilename);
  const gpuFast = gpuAvailable && (target === '8k' || target === '4k');
  const scale = inferScaleFactor(sourceWidth, targetDims.width, { gpuFast });

  let method = null;

  if (mode === 'fast') {
    method = await upscaleWithFfmpeg(
      inputPath,
      outputPath,
      targetDims.width,
      targetDims.height,
      { useGpu: gpuAvailable }
    );
  } else {
    try {
      method = await tryRealesrganService(inputPath, outputPath, scale);
    } catch (err) {
      console.warn('Real-ESRGAN service unavailable, trying fallback:', err.message);
    }

    if (!method) {
      try {
        method = await tryRealesrganCli(inputPath, outputPath, scale);
      } catch (err) {
        console.warn('Real-ESRGAN CLI unavailable, using FFmpeg:', err.message);
      }
    }

    if (!method) {
      method = await upscaleWithFfmpeg(
        inputPath,
        outputPath,
        targetDims.width,
        targetDims.height,
        { useGpu: gpuAvailable }
      );
    } else {
      const aiMeta = await extractMetadata(outputPath);
      const needsFinalScale =
        aiMeta.video?.width !== targetDims.width || aiMeta.video?.height !== targetDims.height;
      if (needsFinalScale) {
        const scaledPath = path.join(config.processedDir, `scaled-${uuidv4()}.mp4`);
        await upscaleWithFfmpeg(outputPath, scaledPath, targetDims.width, targetDims.height, {
          useGpu: gpuAvailable,
        });
        method = 'realesrgan+ffmpeg';
        const { unlink } = await import('fs/promises');
        await unlink(outputPath).catch(() => {});
        const finalMeta = await extractMetadata(scaledPath);
        return buildUpscaleResult({
          method,
          target,
          sourceWidth,
          sourceHeight,
          targetDims,
          outputPath: scaledPath,
          outputFilename: path.basename(scaledPath),
          outputMeta: finalMeta,
        });
      }
    }
  }

  const outputMeta = await extractMetadata(outputPath);
  return buildUpscaleResult({
    method,
    target,
    sourceWidth,
    sourceHeight,
    targetDims,
    outputPath,
    outputFilename,
    outputMeta,
  });
}

function buildUpscaleResult({
  method,
  target,
  sourceWidth,
  sourceHeight,
  targetDims,
  outputPath,
  outputFilename,
  outputMeta,
}) {
  const label = buildUpscaleLabel(method, { width: sourceWidth, height: sourceHeight }, targetDims);

  return {
    skipped: false,
    method,
    targetPreset: target,
    label,
    source: { width: sourceWidth, height: sourceHeight },
    target: targetDims,
    output: {
      width: outputMeta.video?.width,
      height: outputMeta.video?.height,
    },
    outputPath,
    outputFilename,
  };
}

export async function checkUpscaleAvailability() {
  const status = {
    ffmpeg: true,
    realesrganService: Boolean(config.aiUpscaleUrl),
    realesrganCli: Boolean(config.realesrganBin && existsSync(config.realesrganBin)),
    gpu: false,
    device: 'cpu',
  };

  if (config.aiUpscaleUrl) {
    try {
      const res = await fetch(`${config.aiUpscaleUrl}/health`);
      const health = await res.json();
      status.gpu = Boolean(health.gpu);
      status.device = health.device || 'cpu';
    } catch {
      // service unreachable
    }
  }

  status.recommendedMethod = status.gpu
    ? 'realesrgan_service'
    : status.realesrganService
      ? 'realesrgan_service_cpu_slow'
      : 'ffmpeg_lanczos';

  status.speedTip = status.gpu
    ? 'GPU detected — AI quality mode is recommended.'
    : 'No GPU detected — use Fast mode for 8K in seconds, or AI Quality for best results (much slower on CPU).';

  return status;
}
