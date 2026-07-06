# Install CUDA-enabled PyTorch for NVIDIA GPUs (Windows).
# Run from ai-pipeline/upscale after: python -m venv .venv && .\.venv\Scripts\pip install -r requirements.txt

$ErrorActionPreference = "Stop"
$venv = Join-Path $PSScriptRoot ".venv\Scripts"
$py = Join-Path $venv "python.exe"
$pip = Join-Path $venv "pip.exe"

if (-not (Test-Path $py)) {
    Write-Error "Virtual env not found. Run: python -m venv .venv"
}

$torchUrl = "https://download.pytorch.org/whl/cu126/torch-2.12.1%2Bcu126-cp312-cp312-win_amd64.whl"
$tvUrl = "https://download.pytorch.org/whl/cu126/torchvision-0.27.1%2Bcu126-cp312-cp312-win_amd64.whl"
$torchWhl = Join-Path $env:TEMP "torch-2.12.1+cu126-cp312-cp312-win_amd64.whl"
$tvWhl = Join-Path $env:TEMP "torchvision-0.27.1+cu126-cp312-cp312-win_amd64.whl"

Write-Host "Downloading CUDA PyTorch wheels (~2.5 GB)..."
curl.exe -L -o $torchWhl $torchUrl
curl.exe -L -o $tvWhl $tvUrl

& $pip uninstall torch torchvision -y
& $pip install $torchWhl $tvWhl

& $py -c "import torch; print('cuda:', torch.cuda.is_available()); print('device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"
Write-Host "Restart upscale server: uvicorn server:app --host 127.0.0.1 --port 8002"
