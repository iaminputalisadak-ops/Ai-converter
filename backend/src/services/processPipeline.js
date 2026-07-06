import { v4 as uuidv4 } from 'uuid';
import { detectPlatform, isValidUrl } from '../utils/platform.js';
import { fetchVideoMetadata, resolveDownloadUrl } from './videoService.js';
import { downloadToFile, extractMetadata, runAiPipeline } from './ffmpegService.js';
import { processVideoExport } from './mediaProcessingService.js';
import { upscaleVideo } from './upscaleService.js';
import {
  createJob,
  setJobStep,
  completeJob,
  failJob,
  estimateProcessingMs,
  updateJob,
} from './jobService.js';

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 11; SM-N975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.210 Mobile Safari/537.36';

export async function startProcessingJob(payload) {
  const { url, itag, modifications = {}, applyWatermark = true } = payload;

  if (!url || !isValidUrl(url)) {
    throw new Error('A valid HTTP/HTTPS URL is required.');
  }

  let durationSeconds = 30;
  try {
    const platform = detectPlatform(url);
    const meta = await fetchVideoMetadata(url, platform.id);
    durationSeconds = meta.durationSeconds || 30;
  } catch {
    // use default estimate
  }

  const job = createJob({
    durationSeconds,
    upscale: modifications.upscale,
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
  const aiResult = runAiPipeline(localPath, modifications);

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

  let workingPath = localPath;
  let upscaleResult = null;

  if (modifications.upscale?.enabled) {
    const target = (modifications.upscale.target || '4k').toUpperCase();
    const isFast = modifications.upscale.mode === 'fast';
    setJobStep(
      jobId,
      'upscale',
      'running',
      isFast
        ? `Fast upscaling to ${target} with FFmpeg…`
        : `AI upscaling each frame to ${target} — slowest step on CPU…`
    );

    upscaleResult = await upscaleVideo(localPath, {
      target: modifications.upscale.target || '4k',
      mode: modifications.upscale.mode || 'ai',
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

  const filterPreset = modifications.filters?.preset || 'none';
  const audioOptions = modifications.audio || {};
  const needsExport =
    applyWatermark || filterPreset !== 'none' || audioOptions.enabled;

  setJobStep(jobId, 'export', 'running', 'Encoding video with your selected options…');

  let result = {
    jobId,
    platform: platform.id,
    fileMetadata,
    aiPipeline: aiResult,
    upscale: upscaleResult,
  };

  if (needsExport) {
    const processed = await processVideoExport(workingPath, {
      applyWatermark,
      filterPreset,
      audio: audioOptions,
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

  setJobStep(jobId, 'finalize', 'completed');
  completeJob(jobId, result);
}
