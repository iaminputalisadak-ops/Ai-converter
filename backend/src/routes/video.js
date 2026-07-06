import { Router } from 'express';
import path from 'path';
import { existsSync } from 'fs';
import { detectPlatform, isValidUrl } from '../utils/platform.js';
import {
  fetchVideoMetadata,
  resolveDownloadUrl,
} from '../services/videoService.js';
import { listMusicTracks, FILTER_PRESETS } from '../services/mediaProcessingService.js';
import { checkUpscaleAvailability } from '../services/upscaleService.js';
import { startProcessingJob } from '../services/processPipeline.js';
import { getJob } from '../services/jobService.js';
import { config } from '../config.js';

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
    const started = await startProcessingJob(req.body);
    res.status(202).json(started);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/job/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired.' });
  }
  res.json(job);
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
