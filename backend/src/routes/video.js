import { Router } from 'express';
import path from 'path';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { detectPlatform, isValidUrl } from '../utils/platform.js';
import {
  fetchVideoMetadata,
  resolveDownloadUrl,
} from '../services/videoService.js';
import {
  downloadToFile,
  extractMetadata,
  runAiPipeline,
} from '../services/ffmpegService.js';
import { processVideoExport, listMusicTracks, FILTER_PRESETS } from '../services/mediaProcessingService.js';
import { upscaleVideo, checkUpscaleAvailability } from '../services/upscaleService.js';
import { config } from '../config.js';

const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 11; SM-N975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.210 Mobile Safari/537.36';

const router = Router();

router.post('/metadata', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !isValidUrl(url)) {
      return res.status(400).json({ error: 'A valid HTTP/HTTPS URL is required.' });
    }

    const platform = detectPlatform(url);
    const metadata = await fetchVideoMetadata(url, platform.id);

    res.json({ platform, ...metadata });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/download-url', async (req, res) => {
  try {
    const { url, itag } = req.body;
    if (!url || !isValidUrl(url)) {
      return res.status(400).json({ error: 'A valid HTTP/HTTPS URL is required.' });
    }

    const platform = detectPlatform(url);
    const downloadUrl = await resolveDownloadUrl(url, platform.id, itag);

    res.json({ downloadUrl, platform: platform.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/process', async (req, res) => {
  try {
    const { url, itag, modifications = {}, applyWatermark = true } = req.body;

    if (!url || !isValidUrl(url)) {
      return res.status(400).json({ error: 'A valid HTTP/HTTPS URL is required.' });
    }

    const platform = detectPlatform(url);
    const downloadUrl = await resolveDownloadUrl(url, platform.id, itag);
    const filename = `${uuidv4()}.mp4`;

    const downloadHeaders =
      platform.id === 'instagram'
        ? { Referer: 'https://www.instagram.com/', 'User-Agent': MOBILE_UA }
        : platform.id === 'tiktok'
          ? { Referer: 'https://www.tiktok.com/', 'User-Agent': MOBILE_UA }
          : {};

    const localPath = await downloadToFile(downloadUrl, filename, { headers: downloadHeaders });
    const fileMetadata = await extractMetadata(localPath);

    const aiResult = runAiPipeline(localPath, modifications);

    let workingPath = localPath;
    let upscaleResult = null;

    if (modifications.upscale?.enabled) {
      upscaleResult = await upscaleVideo(localPath, {
        target: modifications.upscale.target || '4k',
      });
      if (!upscaleResult.skipped) {
        workingPath = upscaleResult.outputPath;
      }
    }

    const filterPreset = modifications.filters?.preset || 'none';
    const audioOptions = modifications.audio || {};
    const needsExport =
      applyWatermark ||
      filterPreset !== 'none' ||
      audioOptions.enabled;

    let result = {
      jobId: uuidv4(),
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

    if (workingPath !== localPath) {
      const outputMeta = await extractMetadata(workingPath);
      result.outputMetadata = outputMeta;
    }

    res.json(result);
  } catch (err) {
    console.error('Process error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/file/:filename', (req, res) => {
  const { filename } = req.params;
  const safeName = path.basename(filename);

  const processedPath = path.join(config.processedDir, safeName);
  if (existsSync(processedPath)) {
    return res.download(processedPath);
  }

  const uploadPath = path.join(config.uploadDir, safeName);
  if (existsSync(uploadPath)) {
    return res.download(uploadPath);
  }

  res.status(404).json({ error: 'File not found.' });
});

router.get('/music-tracks', (_req, res) => {
  res.json({ tracks: listMusicTracks() });
});

router.get('/filter-presets', (_req, res) => {
  res.json({
    presets: Object.entries(FILTER_PRESETS).map(([id, p]) => ({ id, label: p.label })),
  });
});

router.get('/upscale-status', async (_req, res) => {
  try {
    const status = await checkUpscaleAvailability();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', platform: config.platformId });
});

export default router;
