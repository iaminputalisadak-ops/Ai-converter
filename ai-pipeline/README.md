# AI Video Modification Pipeline

This directory documents the recommended architecture for deploying AI models alongside the Node.js backend.

## Pipeline Stages

```
Input Video
    │
    ▼
┌─────────────────────┐
│ 1. Metadata Extract │  FFmpeg ffprobe (implemented in backend)
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 2. Content Analysis │  YOLOv7 object detection (Python service)
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 3. Style Transfer   │  StyleGAN3 / neural style transfer (GPU function)
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 4. Frame Interp.    │  DAIN for smoothness (GPU function)
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 5. Re-encode        │  FFmpeg merge (implemented in backend)
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 6. Attribution      │  Watermark + metadata fingerprint (implemented)
└─────────────────────┘
```

## Recommended Services

### Object Detection (YOLOv7)

Deploy as a FastAPI microservice:

```python
# ai-pipeline/detection/server.py (example stub)
from fastapi import FastAPI, UploadFile
# import torch; model = torch.hub.load(...)

app = FastAPI()

@app.post("/detect")
async def detect(file: UploadFile):
  # Run YOLOv7, return bounding boxes + labels
  return {"objects": []}
```

Call from Node.js via HTTP before FFmpeg re-encoding.

### Style Transfer (StyleGAN3)

- Train/test locally with PyTorch
- Deploy to AWS Lambda (container image) or Google Cloud Run with GPU
- Process frames in batches; write to temp storage (S3)

### Frame Interpolation (DAIN)

- GPU-intensive; use dedicated inference endpoint
- Input: video frames → Output: interpolated frame sequence
- Re-merge with FFmpeg: `ffmpeg -framerate 60 -i frames/%04d.png -c:v libx264 out.mp4`

## Serverless Cost Model

| Component | Trigger | Compute |
|-----------|---------|---------|
| Metadata API | Per request | Express (always-on or Lambda) |
| Download | Per request | Express + temp storage |
| AI inference | Per job | GPU Lambda / Cloud Run (burst) |
| Storage | Per file | S3 / GCS with lifecycle rules |

## Integration with Backend

Update `runAiPipeline()` in `backend/src/services/ffmpegService.js` to call your deployed services:

```javascript
// Example: call detection service
const formData = new FormData();
formData.append('file', fs.createReadStream(inputPath));
const detection = await fetch(`${AI_DETECTION_URL}/detect`, { method: 'POST', body: formData });
```

## Local Development

For local AI testing without cloud deployment:

1. Run Python services on `localhost:8000`, `localhost:8001`, etc.
2. Set env vars: `AI_DETECTION_URL`, `AI_STYLE_URL`, `AI_INTERP_URL`
3. Use smaller test videos (< 30 seconds) to keep GPU memory manageable
