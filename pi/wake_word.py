"""Listen on the default mic and print when the wake phrase is heard.

    python wake_word.py                       # "HEY BART"
    python wake_word.py --keyword "HEY JARVIS"
    python wake_word.py --score 2.0 --threshold 0.2   # more sensitive

Uses sherpa-onnx keyword spotting: the phrase is plain text, no training.
Same script runs on a Mac and on the Pi.
"""
import argparse
import tarfile
import urllib.request
from pathlib import Path

import numpy as np
import sentencepiece as spm
import sherpa_onnx
import sounddevice as sd

SAMPLE_RATE = 16000
FRAME = 1280  # 80 ms

MODEL_NAME = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
MODEL_URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/{MODEL_NAME}.tar.bz2"
MODELS_DIR = Path(__file__).parent / "models"
MODEL_DIR = MODELS_DIR / MODEL_NAME
CHUNK = "epoch-12-avg-2-chunk-16-left-64.int8"

parser = argparse.ArgumentParser()
parser.add_argument("--keyword", default="HEY BART")
parser.add_argument("--score", type=float, default=1.5, help="boost for the keyword; higher = easier to trigger")
parser.add_argument("--threshold", type=float, default=0.15, help="lower = easier to trigger")
args = parser.parse_args()


def ensure_model():
    if MODEL_DIR.exists():
        return
    MODELS_DIR.mkdir(exist_ok=True)
    archive = MODELS_DIR / f"{MODEL_NAME}.tar.bz2"
    print(f"downloading {MODEL_NAME}...")
    urllib.request.urlretrieve(MODEL_URL, archive)
    with tarfile.open(archive) as tar:
        # filter= only exists on newer Pythons (3.12+, and some 3.11 patch releases)
        tar.extractall(MODELS_DIR, **({"filter": "data"} if hasattr(tarfile, "data_filter") else {}))
    archive.unlink()


def write_keywords_file():
    # The model matches BPE tokens, e.g. "HEY BART" -> "▁HE Y ▁B AR T @HEY_BART"
    sp = spm.SentencePieceProcessor(model_file=str(MODEL_DIR / "bpe.model"))
    phrase = args.keyword.upper()
    tokens = " ".join(sp.encode(phrase, out_type=str))
    path = MODELS_DIR / "keywords.txt"
    path.write_text(f"{tokens} @{phrase.replace(' ', '_')}\n")
    return path


ensure_model()
spotter = sherpa_onnx.KeywordSpotter(
    tokens=str(MODEL_DIR / "tokens.txt"),
    encoder=str(MODEL_DIR / f"encoder-{CHUNK}.onnx"),
    decoder=str(MODEL_DIR / f"decoder-{CHUNK}.onnx"),
    joiner=str(MODEL_DIR / f"joiner-{CHUNK}.onnx"),
    keywords_file=str(write_keywords_file()),
    keywords_score=args.score,
    keywords_threshold=args.threshold,
    num_threads=1,
)
stream = spotter.create_stream()

with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", blocksize=FRAME) as mic:
    print(f"listening for {args.keyword.upper()!r} on {sd.query_devices(kind='input')['name']}...")
    while True:
        frame, _ = mic.read(FRAME)
        stream.accept_waveform(SAMPLE_RATE, np.squeeze(frame))
        while spotter.is_ready(stream):
            spotter.decode_stream(stream)
            if keyword := spotter.get_result(stream):
                print("heard it:", keyword)
                spotter.reset_stream(stream)
