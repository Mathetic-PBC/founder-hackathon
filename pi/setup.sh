#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ $EUID -eq 0 ]]; then
  echo 'Run as your normal Pi user, without sudo (the apt steps use sudo).'
  exit 1
fi

sudo apt-get update
sudo apt-get install -y libportaudio2 python3-venv git alsa-utils ffmpeg curl ca-certificates
python3 -m venv venv
venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt

model_name=sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01
model_dir="models/$model_name"
chunk=epoch-12-avg-2-chunk-16-left-64
mkdir -p models recordings
missing=0
for file in bpe.model tokens.txt "encoder-$chunk.int8.onnx" "decoder-$chunk.onnx" "joiner-$chunk.int8.onnx"; do
  [[ -s "$model_dir/$file" ]] || missing=1
done
if [[ $missing -eq 1 ]]; then
  staging=$(mktemp -d models/.download.XXXXXX)
  trap 'rm -rf -- "$staging"' EXIT
  curl --fail --location --retry 4 --connect-timeout 15 --max-time 600 \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/$model_name.tar.bz2" \
    --output "$staging/model.tar.bz2"
  venv/bin/python - "$staging" <<'PY'
import sys, tarfile
from pathlib import Path
staging = Path(sys.argv[1])
with tarfile.open(staging / "model.tar.bz2") as archive:
    archive.extractall(staging, filter="data")
PY
  for file in bpe.model tokens.txt "encoder-$chunk.int8.onnx" "decoder-$chunk.onnx" "joiner-$chunk.int8.onnx"; do
    test -s "$staging/$model_name/$file"
  done
  mkdir -p "$model_dir"
  cp -a "$staging/$model_name/." "$model_dir/"
fi

venv/bin/sherpa-onnx-cli text2token \
  --tokens "$model_dir/tokens.txt" --tokens-type bpe \
  --bpe-model "$model_dir/bpe.model" keywords.txt models/keywords.txt.tmp
mv models/keywords.txt.tmp models/keywords.txt
if [[ ! -e .env ]]; then
  (umask 077; cp .env.example .env)
fi
chmod 600 .env
echo 'Setup complete. Edit pi/.env as needed, then run: venv/bin/python -u wake.py'
echo 'Keyword tokens:'
cat models/keywords.txt
