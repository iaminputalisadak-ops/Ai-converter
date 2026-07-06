const API_BASE = '/api/video';

async function parseResponse(res) {
  const text = await res.text();

  if (!text) {
    if (res.status === 502 || res.status === 504) {
      throw new Error('Backend server is not running. Run npm run dev in the project folder.');
    }
    throw new Error(`Server returned an empty response (${res.status}). Is the backend running on port 3001?`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid server response (${res.status}). Backend may be offline or crashed.`);
  }
}

export async function fetchMetadata(url) {
  const res = await fetch(`${API_BASE}/metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await parseResponse(res);
  if (!res.ok) throw new Error(data.error || 'Failed to fetch metadata');
  return data;
}

export async function getDownloadUrl(url, itag) {
  const res = await fetch(`${API_BASE}/download-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, itag }),
  });
  const data = await parseResponse(res);
  if (!res.ok) throw new Error(data.error || 'Failed to resolve download URL');
  return data;
}

export async function processVideo({ url, itag, modifications, applyWatermark }) {
  const res = await fetch(`${API_BASE}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, itag, modifications, applyWatermark }),
  });
  const data = await parseResponse(res);
  if (!res.ok) throw new Error(data.error || 'Processing failed');
  return data;
}

export async function fetchJobStatus(jobId) {
  const res = await fetch(`${API_BASE}/job/${jobId}`);
  const data = await parseResponse(res);
  if (!res.ok) throw new Error(data.error || 'Failed to fetch job status');
  return data;
}

export async function waitForJob(jobId, { onUpdate, pollMs = 1000 } = {}) {
  while (true) {
    const job = await fetchJobStatus(jobId);
    onUpdate?.(job);

    if (job.status === 'completed') return job.result;
    if (job.status === 'failed') throw new Error(job.error || 'Processing failed');

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function fetchUpscaleStatus() {
  const res = await fetch(`${API_BASE}/upscale-status`);
  const data = await parseResponse(res);
  if (!res.ok) throw new Error(data.error || 'Failed to check upscale status');
  return data;
}

export async function fetchMusicTracks() {
  const res = await fetch(`${API_BASE}/music-tracks`);
  const data = await parseResponse(res);
  if (!res.ok) throw new Error(data.error || 'Failed to load music tracks');
  return data.tracks;
}

export async function fetchFilterPresets() {
  const res = await fetch(`${API_BASE}/filter-presets`);
  const data = await parseResponse(res);
  if (!res.ok) throw new Error(data.error || 'Failed to load filter presets');
  return data.presets;
}
