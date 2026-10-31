"""Wait for the wake phrase, chime, then record what you say until you stop talking.

    python wake_word.py                       # "HEY JARVIS" or "JARVIS"
    python wake_word.py --keyword "HEY BART" --keyword "BART"
    python wake_word.py --score 2.0 --threshold 0.1   # wake word more sensitive

Each utterance is saved to recordings/ and the terminal prints its length and
file size, then it goes back to waiting for the wake phrase.

Uses sherpa-onnx for both steps: keyword spotting for the wake phrase (plain
text, no training) and Silero VAD to tell when you stop talking.
Same script runs on a Mac and on the Pi.
"""
import argparse
import tarfile
import urllib.request
import wave
from datetime import datetime
from pathlib import Path

import numpy as np
import sentencepiece as spm
import sherpa_onnx
import sounddevice as sd

SAMPLE_RATE = 16000
FRAME = 1280  # 80 ms

HERE = Path(__file__).parent
MODELS_DIR = HERE / "models"
RECORDINGS_DIR = HERE / "recordings"

KWS_NAME = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
KWS_URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/{KWS_NAME}.tar.bz2"
KWS_DIR = MODELS_DIR / KWS_NAME
CHUNK = "epoch-12-avg-2-chunk-16-left-64.int8"

VAD_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
VAD_PATH = MODELS_DIR / "silero_vad.onnx"

parser = argparse.ArgumentParser()
parser.add_argument("--keyword", action="append", help="wake phrase; repeat for several (default: HEY JARVIS, JARVIS)")
parser.add_argument("--score", type=float, default=1.5, help="boost for the keyword; higher = easier to trigger")
parser.add_argument("--threshold", type=float, default=0.15, help="lower = easier to trigger")
parser.add_argument("--silence", type=float, default=0.8, help="seconds of silence that count as you having stopped talking")
args = parser.parse_args()
keywords = [k.upper() for k in args.keyword or ["HEY JARVIS", "JARVIS"]]


def ensure_models():
    MODELS_DIR.mkdir(exist_ok=True)
    if not KWS_DIR.exists():
        archive = MODELS_DIR / f"{KWS_NAME}.tar.bz2"
        print(f"downloading {KWS_NAME}...")
        urllib.request.urlretrieve(KWS_URL, archive)
        with tarfile.open(archive) as tar:
            # filter= only exists on newer Pythons (3.12+, and some 3.11 patch releases)
            tar.extractall(MODELS_DIR, **({"filter": "data"} if hasattr(tarfile, "data_filter") else {}))
        archive.unlink()
    if not VAD_PATH.exists():
        print("downloading silero_vad.onnx...")
        urllib.request.urlretrieve(VAD_URL, VAD_PATH)


def write_keywords_file():
    # The model matches BPE tokens, one phrase per line, e.g. "HEY BART" -> "▁HE Y ▁B AR T @HEY_BART"
    sp = spm.SentencePieceProcessor(model_file=str(KWS_DIR / "bpe.model"))
    lines = [f"{' '.join(sp.encode(k, out_type=str))} @{k.replace(' ', '_')}" for k in keywords]
    path = MODELS_DIR / "keywords.txt"
    path.write_text("\n".join(lines) + "\n")
    return path


def chime():
    # Two rising beeps, generated so there's no sound file to ship
    rate = int(sd.query_devices(kind="output")["default_samplerate"])
    t = np.arange(int(rate * 0.12)) / rate
    fade = np.minimum(1, np.minimum(t, t[::-1]) / 0.01)
    beeps = [0.3 * np.sin(2 * np.pi * f * t) * fade for f in (660, 990)]
    sd.play(np.concatenate([beeps[0], np.zeros(int(rate * 0.04)), beeps[1]]).astype(np.float32), rate)
    sd.wait()


def save(samples):
    RECORDINGS_DIR.mkdir(exist_ok=True)
    path = RECORDINGS_DIR / f"{datetime.now():%Y%m%d-%H%M%S-%f}.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
    return path


ensure_models()
spotter = sherpa_onnx.KeywordSpotter(
    tokens=str(KWS_DIR / "tokens.txt"),
    encoder=str(KWS_DIR / f"encoder-{CHUNK}.onnx"),
    decoder=str(KWS_DIR / f"decoder-{CHUNK}.onnx"),
    joiner=str(KWS_DIR / f"joiner-{CHUNK}.onnx"),
    keywords_file=str(write_keywords_file()),
    keywords_score=args.score,
    keywords_threshold=args.threshold,
    num_threads=1,
)
stream = spotter.create_stream()

vad_config = sherpa_onnx.VadModelConfig()
vad_config.silero_vad.model = str(VAD_PATH)
vad_config.silero_vad.min_silence_duration = args.silence
vad_config.silero_vad.max_speech_duration = 30
vad_config.sample_rate = SAMPLE_RATE
vad = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=60)
VAD_WINDOW = vad_config.silero_vad.window_size

with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", blocksize=FRAME) as mic:
    print(f"waiting for {' / '.join(keywords)} on {sd.query_devices(kind='input')['name']}...")
    listening = speaking = False
    pending = np.zeros(0, dtype=np.float32)
    while True:
        frame, _ = mic.read(FRAME)
        frame = np.squeeze(frame)

        if not listening:
            stream.accept_waveform(SAMPLE_RATE, frame)
            while spotter.is_ready(stream):
                spotter.decode_stream(stream)
                if keyword := spotter.get_result(stream):
                    spotter.reset_stream(stream)
                    print(f"heard {keyword}, listening...")
                    chime()
                    mic.read(mic.read_available)  # drop audio captured during the chime
                    vad.reset()
                    pending = np.zeros(0, dtype=np.float32)
                    listening, speaking = True, False
                    break
            continue

        # Silero wants fixed-size windows
        pending = np.concatenate([pending, frame])
        while len(pending) >= VAD_WINDOW:
            vad.accept_waveform(pending[:VAD_WINDOW])
            pending = pending[VAD_WINDOW:]
        if vad.is_speech_detected() and not speaking:
            speaking = True
            print("  you're talking...")
        if not vad.empty():
            samples = np.array(vad.front.samples, dtype=np.float32)
            vad.pop()
            path = save(samples)
            print(f"  you stopped talking: {len(samples) / SAMPLE_RATE:.1f} s, "
                  f"{path.stat().st_size / 1024:.1f} KB -> {path.relative_to(HERE)}")
            listening = False
            print(f"waiting for {' / '.join(keywords)}...")
