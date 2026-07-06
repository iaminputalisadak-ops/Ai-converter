"""
Real-ESRGAN upscaling microservice.

Setup:
  pip install -r requirements.txt
  # Download model weights to ai-pipeline/upscale/weights/

Run:
  uvicorn server:app --host 0.0.0.0 --port 8002

Set in backend/.env:
  AI_UPSCALE_URL=http://localhost:8002
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

app = FastAPI(title="Real-ESRGAN Upscale Service")

WEIGHTS_DIR = Path(__file__).parent / "weights"
DEFAULT_MODEL = WEIGHTS_DIR / "RealESRGAN_x4plus.pth"


def upscale_with_realesrgan(input_path: Path, output_path: Path, scale: int) -> None:
    """Run Real-ESRGAN inference. Requires realesrgan package + model weights."""
    try:
        from realesrgan import RealESRGANer
        from basicsr.archs.rrdbnet_arch import RRDBNet
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="Real-ESRGAN not installed. Run: pip install -r requirements.txt",
        ) from exc

    if not DEFAULT_MODEL.exists():
        raise HTTPException(
            status_code=503,
            detail=f"Model weights not found at {DEFAULT_MODEL}. See README for download instructions.",
        )

    model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
    upsampler = RealESRGANer(
        scale=4,
        model_path=str(DEFAULT_MODEL),
        model=model,
        tile=256,
        tile_pad=10,
        pre_pad=0,
        half=True,
    )

    import cv2

    if input_path.suffix.lower() in {".mp4", ".mov", ".webm", ".mkv"}:
        _upscale_video_frames(input_path, output_path, upsampler, scale)
        return

    image = cv2.imread(str(input_path), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise HTTPException(status_code=400, detail="Could not read input file.")

    output, _ = upsampler.enhance(image, outscale=scale)
    cv2.imwrite(str(output_path), output)


def _upscale_video_frames(input_path: Path, output_path: Path, upsampler, scale: int) -> None:
    import cv2

    cap = cv2.VideoCapture(str(input_path))
    if not cap.isOpened():
        raise HTTPException(status_code=400, detail="Could not open video.")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    out_w, out_h = width * scale, height * scale

    writer = cv2.VideoWriter(str(output_path), fourcc, fps, (out_w, out_h))

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        upscaled, _ = upsampler.enhance(frame, outscale=scale)
        writer.write(upscaled)

    cap.release()
    writer.release()

    _mux_audio(input_path, output_path)


def _mux_audio(video_path: Path, source_path: Path) -> None:
    """Copy original audio track onto upscaled video via FFmpeg."""
    if not shutil.which("ffmpeg"):
        return

    temp = video_path.with_suffix(".tmp.mp4")
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(video_path),
            "-i",
            str(source_path),
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0?",
            "-shortest",
            str(temp),
        ],
        check=True,
        capture_output=True,
    )
    temp.replace(video_path)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model_exists": DEFAULT_MODEL.exists(),
        "ffmpeg": shutil.which("ffmpeg") is not None,
    }


@app.post("/upscale")
async def upscale(
    file: UploadFile = File(...),
    scale: int = Form(4),
):
    if scale not in (2, 4):
        raise HTTPException(status_code=400, detail="Scale must be 2 or 4.")

    suffix = Path(file.filename or "input.mp4").suffix or ".mp4"
    work_dir = Path(tempfile.mkdtemp(prefix="upscale-"))
    input_path = work_dir / f"input{suffix}"
    output_path = work_dir / f"output-{uuid.uuid4().hex}.mp4"

    try:
        with open(input_path, "wb") as f:
            shutil.copyfileobj(file.file, f)

        upscale_with_realesrgan(input_path, output_path, scale)

        if not output_path.exists():
            raise HTTPException(status_code=500, detail="Upscaling produced no output.")

        return FileResponse(
            output_path,
            media_type="video/mp4",
            filename="upscaled.mp4",
            background=None,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
