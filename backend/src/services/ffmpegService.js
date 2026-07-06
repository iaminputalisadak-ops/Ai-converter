import { createWriteStream, existsSync } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import { config } from '../config.js';

export function extractMetadata(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);

      const video = data.streams.find((s) => s.codec_type === 'video');
      const audio = data.streams.find((s) => s.codec_type === 'audio');

      resolve({
        duration: data.format.duration,
        size: data.format.size,
        bitrate: data.format.bit_rate,
        format: data.format.format_name,
        video: video
          ? {
              codec: video.codec_name,
              width: video.width,
              height: video.height,
              fps: evalFraction(video.r_frame_rate),
            }
          : null,
        audio: audio
          ? {
              codec: audio.codec_name,
              sampleRate: audio.sample_rate,
              channels: audio.channels,
            }
          : null,
      });
    });
  });
}

function evalFraction(rate) {
  if (!rate) return null;
  const [num, den] = rate.split('/').map(Number);
  return den ? num / den : num;
}

export async function downloadToFile(url, filename, options = {}) {
  const { headers = {} } = options;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);
  }

  const filePath = path.join(config.uploadDir, filename);
  await pipeline(response.body, createWriteStream(filePath));
  return filePath;
}

export function applyWatermarkAndFingerprint(inputPath, options = {}) {
  const {
    fingerprintId = uuidv4(),
    watermarkPath = config.watermarkPath,
    platformId = config.platformId,
  } = options;

  const outputFilename = `processed-${fingerprintId}.mp4`;
  const outputPath = path.join(config.processedDir, outputFilename);

  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath);

    const filters = [];
    if (existsSync(watermarkPath)) {
      command = command.input(watermarkPath);
      filters.push('overlay=W-w-20:H-h-20');
    }

    if (filters.length > 0) {
      command = command.complexFilter(filters);
    }

    command
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-c:a aac',
        '-b:a 128k',
        `-metadata title=${JSON.stringify(`Processed by ${platformId}`)}`,
        `-metadata comment=${JSON.stringify(`fingerprint:${fingerprintId}`)}`,
        `-metadata encoded_by=${JSON.stringify(platformId)}`,
        `-metadata copyright=${JSON.stringify(platformId)}`,
      ])
      .on('end', () =>
        resolve({
          outputPath,
          outputFilename,
          fingerprintId,
          downloadUrl: `/api/video/file/${outputFilename}`,
        })
      )
      .on('error', reject)
      .save(outputPath);
  });
}

export function runAiPipeline(inputPath, modifications = {}) {
  const steps = [];

  if (modifications.styleTransfer) {
    steps.push({
      step: 'style_transfer',
      status: 'stub',
      message: 'StyleGAN3 integration point — deploy as serverless GPU function',
    });
  }

  if (modifications.frameInterpolation) {
    steps.push({
      step: 'frame_interpolation',
      status: 'stub',
      message: 'DAIN integration point — requires GPU inference service',
    });
  }

  if (modifications.objectDetection) {
    steps.push({
      step: 'object_detection',
      status: 'stub',
      message: 'YOLOv7 integration point — run via Python microservice',
    });
  }

  return {
    inputPath,
    modifications,
    steps,
    note: 'AI steps are architecture stubs. Connect TensorFlow/PyTorch models via serverless functions.',
  };
}
