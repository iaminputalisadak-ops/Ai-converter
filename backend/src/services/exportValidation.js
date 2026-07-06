import { existsSync } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { listMusicTracks } from './mediaProcessingService.js';

export function validateExportOptions({ modifications = {}, applyWatermark = true } = {}) {
  const errors = [];
  const audio = modifications.audio || {};
  const filterPreset = modifications.filters?.preset || 'none';

  if (audio.enabled) {
    const tracks = listMusicTracks();
    if (tracks.length === 0) {
      errors.push(
        'Background music is enabled but no music files were found. Add MP3 files to backend/assets/music/ and refresh the page.'
      );
    } else if (!audio.track) {
      errors.push('Background music is enabled — please select a music track from the dropdown.');
    } else {
      const musicPath = path.join(config.assetsDir, 'music', path.basename(audio.track));
      if (!existsSync(musicPath)) {
        errors.push(`Music track not found: ${audio.track}`);
      }
    }
  }

  if (applyWatermark && !existsSync(config.watermarkPath)) {
    // Text watermark fallback is used at export time — not a blocking error.
  }

  const willExport =
    applyWatermark ||
    (filterPreset && filterPreset !== 'none') ||
    Boolean(audio.enabled);

  if (!willExport && modifications.upscale?.enabled !== true) {
    errors.push(
      'Nothing to apply — choose a video filter, enable watermark/music, or select an AI upscale option.'
    );
  }

  return errors;
}
