import { v4 as uuidv4 } from 'uuid';

const jobs = new Map();

const STEP_WEIGHTS = {
  resolve: 5,
  download: 15,
  analyze: 5,
  upscale: 45,
  export: 25,
  finalize: 5,
};

export function estimateProcessingMs(options = {}) {
  const duration = options.durationSeconds || 30;
  const { upscale, filterPreset, audio, applyWatermark } = options;

  let seconds = 10;

  if (upscale?.enabled) {
    const factor = upscale.mode === 'fast' ? 0.5 : upscale.target === '8k' ? 14 : upscale.target === '4k' ? 9 : 6;
    seconds += duration * factor;
  }

  if (filterPreset && filterPreset !== 'none') seconds += duration * 1.5;
  if (audio?.enabled) seconds += duration * 1.2;
  if (applyWatermark) seconds += duration * 0.8;

  seconds += 8;

  return Math.round(Math.max(seconds, 20) * 1000);
}

function buildSteps(options) {
  const steps = [
    { id: 'resolve', label: 'Resolving video URL', status: 'pending' },
    { id: 'download', label: 'Downloading source video', status: 'pending' },
    { id: 'analyze', label: 'Reading video metadata', status: 'pending' },
  ];

  if (options.upscale?.enabled) {
    const target = options.upscale.target?.toUpperCase() || '4K';
    steps.push({
      id: 'upscale',
      label:
        options.upscale.mode === 'fast'
          ? `Fast upscale to ${target} (FFmpeg)`
          : `AI upscaling to ${target} (Real-ESRGAN)`,
      status: 'pending',
    });
  }

  const exportParts = [];
  if (options.filterPreset && options.filterPreset !== 'none') {
    exportParts.push(`${options.filterPreset} filter`);
  }
  if (options.audio?.enabled) exportParts.push('background music');
  if (options.applyWatermark) exportParts.push('watermark');

  steps.push({
    id: 'export',
    label: exportParts.length
      ? `Applying ${exportParts.join(', ')}`
      : 'Encoding final video',
    status: 'pending',
  });

  steps.push({ id: 'finalize', label: 'Finalizing output', status: 'pending' });

  return steps;
}

function computeProgress(steps) {
  const activeWeights = steps.reduce((sum, step) => {
    return sum + (STEP_WEIGHTS[step.id] || 10);
  }, 0);

  let done = 0;
  for (const step of steps) {
    const weight = STEP_WEIGHTS[step.id] || 10;
    if (step.status === 'completed') done += weight;
    else if (step.status === 'running') done += weight * 0.4;
  }

  return Math.min(99, Math.round((done / activeWeights) * 100));
}

function formatEta(ms) {
  if (!ms || ms < 1000) return 'less than a minute';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `~${s}s`;
  if (m < 60) return `~${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return `~${h}h ${rem}m`;
}

export function createJob(options = {}) {
  const id = uuidv4();
  const startedAt = Date.now();
  const estimatedTotalMs = estimateProcessingMs(options);

  const job = {
    id,
    status: 'queued',
    message: 'Starting…',
    steps: buildSteps(options),
    progress: 0,
    startedAt,
    estimatedTotalMs,
    estimatedRemainingMs: estimatedTotalMs,
    elapsedMs: 0,
    etaLabel: formatEta(estimatedTotalMs),
    result: null,
    error: null,
  };

  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  const job = jobs.get(id);
  if (!job) return null;

  job.elapsedMs = Date.now() - job.startedAt;
  if (job.status === 'running') {
    const progressRatio = Math.max(job.progress / 100, 0.05);
    job.estimatedRemainingMs = Math.max(
      0,
      Math.round(job.elapsedMs / progressRatio - job.elapsedMs)
    );
    job.etaLabel = formatEta(job.estimatedRemainingMs);
  } else if (job.status === 'completed') {
    job.progress = 100;
    job.estimatedRemainingMs = 0;
    job.etaLabel = 'Done';
  }

  return job;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  job.elapsedMs = Date.now() - job.startedAt;
  job.progress = computeProgress(job.steps);
  return job;
}

export function setJobStep(id, stepId, status, message) {
  const job = jobs.get(id);
  if (!job) return null;

  const now = Date.now();
  for (const step of job.steps) {
    if (step.id === stepId) {
      if (status === 'running' && !step.startedAt) step.startedAt = now;
      if (status === 'completed') step.completedAt = now;
      step.status = status;
    } else if (status === 'running' && step.status === 'pending') {
      break;
    } else if (step.id !== stepId && step.status === 'running' && status !== 'running') {
      step.status = 'completed';
      step.completedAt = now;
    }
  }

  job.status = status === 'failed' ? 'failed' : 'running';
  if (message) job.message = message;
  job.progress = computeProgress(job.steps);
  job.elapsedMs = Date.now() - job.startedAt;

  return job;
}

export function completeJob(id, result) {
  const job = jobs.get(id);
  if (!job) return null;

  for (const step of job.steps) {
    if (step.status !== 'completed') {
      step.status = 'completed';
      step.completedAt = Date.now();
    }
  }

  job.status = 'completed';
  job.progress = 100;
  job.message = 'Processing complete — ready to download';
  job.result = result;
  job.estimatedRemainingMs = 0;
  job.etaLabel = 'Done';
  job.elapsedMs = Date.now() - job.startedAt;

  setTimeout(() => jobs.delete(id), 60 * 60 * 1000);
  return job;
}

export function failJob(id, error) {
  const job = jobs.get(id);
  if (!job) return null;

  job.status = 'failed';
  job.error = error?.message || String(error);
  job.message = job.error;
  job.elapsedMs = Date.now() - job.startedAt;

  const running = job.steps.find((s) => s.status === 'running');
  if (running) running.status = 'failed';

  setTimeout(() => jobs.delete(id), 30 * 60 * 1000);
  return job;
}
