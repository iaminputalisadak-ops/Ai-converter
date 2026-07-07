import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { detectPlatform, isValidUrl } from '../utils/platform.js';
import { fetchVideoMetadata, resolveDownloadUrl } from './videoService.js';
import { downloadToFile, extractMetadata } from './ffmpegService.js';
import { processVideoExport } from './mediaProcessingService.js';
import { upscaleVideo, checkUpscaleAvailability, computeUpscaleTarget } from './upscaleService.js';
import { validateExportOptions } from './exportValidation.js';
import { runVideoEnhancements, generateThumbnailAsync, needsSeparateEnhancePass } from './videoEnhancementService.js';
import {
  createJob,
  setJobStep,
  completeJob,
  failJob,
  estimateProcessingMs,
  updateJob,
} from './jobService.js';
import { config } from '../config.js';

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 11; SM-N975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.210 Mobile Safari/537.36';

export async function startProcessingJob(payload) {
  const { url, itag, modifications = {}, applyWatermark = true } = payload;

  if (!url || !isValidUrl(url)) {
    throw new Error('A valid HTTP/HTTPS URL is required.');
  }

  const validationErrors = validateExportOptions({ modifications, applyWatermark });
  if (validationErrors.length > 0) {
    throw new Error(validationErrors[0]);
  }

  let durationSeconds = 30;
  try {
    const platform = detectPlatform(url);
    const meta = await fetchVideoMetadata(url, platform.id);
    durationSeconds = meta.durationSeconds || 30;
  } catch {
    // use default estimate
  }

  let gpuAvailable = false;
  try {
    const upscaleStatus = await checkUpscaleAvailability();
    gpuAvailable = upscaleStatus.gpu;
  } catch {
    // use CPU estimate
  }

  const job = createJob({
    durationSeconds,
    upscale: modifications.upscale
      ? { ...modifications.upscale, gpuAvailable }
      : modifications.upscale,
    filterPreset: modifications.filters?.preset,
    audio: modifications.audio,
    applyWatermark,
  });

  runPipeline(job.id, payload).catch((err) => {
    console.error('Pipeline error:', err);
    failJob(job.id, err);
  });

  return { jobId: job.id, estimatedTotalMs: job.estimatedTotalMs, etaLabel: job.etaLabel };
}

async function runPipeline(jobId, payload) {
  const { url, itag, modifications = {}, applyWatermark = true } = payload;

  setJobStep(jobId, 'resolve', 'running', 'Resolving direct video URL from platform…');

  const platform = detectPlatform(url);
  const downloadUrl = await resolveDownloadUrl(url, platform.id, itag);

  setJobStep(jobId, 'resolve', 'completed');
  setJobStep(jobId, 'download', 'running', `Downloading video from ${platform.label}…`);

  const filename = `${uuidv4()}.mp4`;
  const downloadHeaders =
    platform.id === 'instagram'
      ? { Referer: 'https://www.instagram.com/', 'User-Agent': MOBILE_UA }
      : platform.id === 'tiktok'
        ? { Referer: 'https://www.tiktok.com/', 'User-Agent': MOBILE_UA }
        : {};

  const localPath = await downloadToFile(downloadUrl, filename, { headers: downloadHeaders });

  setJobStep(jobId, 'download', 'completed');
  setJobStep(jobId, 'analyze', 'running', 'Analyzing resolution, duration, and codec…');

  const fileMetadata = await extractMetadata(localPath);

  updateJob(jobId, {
    estimatedTotalMs: estimateProcessingMs({
      durationSeconds: fileMetadata.duration || 30,
      upscale: modifications.upscale,
      filterPreset: modifications.filters?.preset,
      audio: modifications.audio,
      applyWatermark,
    }),
  });

  setJobStep(jobId, 'analyze', 'completed');

  let gpuAvailable = false;
  try {
    const upscaleStatus = await checkUpscaleAvailability();
    gpuAvailable = upscaleStatus.gpu;
  } catch {
    // CPU fallback
  }

  const separateEnhance = needsSeparateEnhancePass(modifications);
  setJobStep(
    jobId,
    'enhance',
    'running',
    separateEnhance
      ? 'Applying optional AI enhancements…'
      : 'Preparing single-pass GPU encode (all effects merged)…'
  );

  const enhancement = await runVideoEnhancements(localPath, modifications, fileMetadata);
  let workingPath = enhancement.outputPath;
  setJobStep(jobId, 'enhance', 'completed', 'Enhancements queued — starting encode…');

  let upscaleResult = null;

  const filterPreset = modifications.filters?.preset || 'none';
  const audioOptions = modifications.audio || {};
  const hasEnhancementFilters = (enhancement.mergeableFilters || []).length > 0;
  const needsExport =
    applyWatermark ||
    filterPreset !== 'none' ||
    audioOptions.enabled ||
    modifications.fadeTransitions ||
    hasEnhancementFilters;
  const isFastUpscale =
    modifications.upscale?.enabled === true && modifications.upscale.mode === 'fast';

  if (isFastUpscale && needsExport) {
    const target = (modifications.upscale.target || '4k').toUpperCase();
    const sourceW = fileMetadata.video?.width;
    const sourceH = fileMetadata.video?.height;

    const targetDims =
      sourceW && sourceH
        ? computeUpscaleTarget(sourceW, sourceH, modifications.upscale.target || '4k')
        : null;

    setJobStep(
      jobId,
      'upscale',
      'running',
      `Single-pass GPU encode: scale to ${target}, filter & watermark…`
    );

    const processed = await processVideoExport(workingPath, {
      applyWatermark,
      filterPreset,
      audio: audioOptions,
      scaleTo: targetDims,
      audioEnhance: enhancement.audioEnhance,
      fadeTransitions: modifications.fadeTransitions,
      enhancementFilters: enhancement.mergeableFilters,
      useGpuScale: gpuAvailable,
    });

    workingPath = processed.outputPath;
    upscaleResult = {
      skipped: false,
      method: 'ffmpeg_merged',
      label: targetDims
        ? `Fast upscale to ${targetDims.width}×${targetDims.height} (single pass)`
        : `Fast upscale to ${target} (single pass)`,
      target: targetDims,
      outputPath: processed.outputPath,
      outputFilename: processed.outputFilename,
    };

    setJobStep(jobId, 'upscale', 'completed', upscaleResult.label);
    setJobStep(jobId, 'export', 'completed', 'Filter, music, and watermark applied');

    const result = {
      jobId,
      platform: platform.id,
      fileMetadata,
      enhancements: enhancement.steps,
      thumbnail: null,
      upscale: upscaleResult,
      ...processed,
      appliedFilter: processed.appliedFilter,
      appliedMusic: processed.appliedMusic,
      outputMetadata: await extractMetadata(processed.outputPath),
    };

    if (modifications.generateThumbnail !== false) {
      generateThumbnailAsync(processed.outputPath, result.outputMetadata).then((thumb) => {
        if (thumb) result.thumbnail = thumb;
      });
    }

    setJobStep(jobId, 'finalize', 'running', 'Saving final file…');
    setJobStep(jobId, 'finalize', 'completed');
    completeJob(jobId, result);
    return;
  }

  if (modifications.upscale?.enabled === true) {
    const target = (modifications.upscale.target || '4k').toUpperCase();
    const isFast = modifications.upscale.mode === 'fast';

    setJobStep(
      jobId,
      'upscale',
      'running',
      isFast
        ? `Fast upscaling to ${target} with FFmpeg…`
        : gpuAvailable
          ? `AI upscaling to ${target} on GPU…`
          : `AI upscaling each frame to ${target} — slowest step on CPU…`
    );

    upscaleResult = await upscaleVideo(workingPath, {
      target: modifications.upscale.target || '4k',
      mode: modifications.upscale.mode || 'ai',
      gpuAvailable,
    });

    if (!upscaleResult.skipped) {
      workingPath = upscaleResult.outputPath;
    }

    setJobStep(
      jobId,
      'upscale',
      'completed',
      upscaleResult.skipped
        ? upscaleResult.reason
        : `Upscaled: ${upscaleResult.label}`
    );
  }

  const filterPresetAfterUpscale = modifications.filters?.preset || 'none';
  const audioOptionsAfterUpscale = modifications.audio || {};
  const needsExportAfterUpscale =
    applyWatermark ||
    filterPresetAfterUpscale !== 'none' ||
    audioOptionsAfterUpscale.enabled ||
    modifications.fadeTransitions ||
    hasEnhancementFilters;

  setJobStep(jobId, 'export', 'running', 'GPU encoding: filter, music & watermark in one pass…');

  let result = {
    jobId,
    platform: platform.id,
    fileMetadata,
    enhancements: enhancement.steps,
    thumbnail: null,
    upscale: upscaleResult,
  };

  if (needsExportAfterUpscale) {
    const processed = await processVideoExport(workingPath, {
      applyWatermark,
      filterPreset: filterPresetAfterUpscale,
      audio: audioOptionsAfterUpscale,
      audioEnhance: enhancement.audioEnhance,
      fadeTransitions: modifications.fadeTransitions,
      enhancementFilters: enhancement.mergeableFilters,
      useGpuScale: gpuAvailable,
    });
    result = {
      ...result,
      ...processed,
      appliedFilter: processed.appliedFilter,
      appliedMusic: processed.appliedMusic,
    };
  } else if (upscaleResult && !upscaleResult.skipped) {
    result.downloadUrl = `/api/video/file/${upscaleResult.outputFilename}`;
    result.outputFilename = upscaleResult.outputFilename;
  } else {
    result.downloadUrl = `/api/video/file/${filename}`;
    result.outputFilename = filename;
  }

  setJobStep(jobId, 'export', 'completed');
  setJobStep(jobId, 'finalize', 'running', 'Saving final file…');

  if (workingPath !== localPath) {
    result.outputMetadata = await extractMetadata(workingPath);
  }

  if (modifications.generateThumbnail !== false) {
    const thumbMeta = result.outputMetadata || fileMetadata;
    const thumbSource = result.outputFilename
      ? path.join(config.processedDir, result.outputFilename)
      : workingPath;
    generateThumbnailAsync(thumbSource, thumbMeta).then((thumb) => {
      if (thumb) result.thumbnail = thumb;
    });
  }

  setJobStep(jobId, 'finalize', 'completed');
  completeJob(jobId, result);
}
