"""Wait for the wake phrase, chime, then record each sentence you say until you say "quit".

    python wake_word.py                       # wake: "HEY JARVIS" or "JARVIS", stop: "QUIT"
    python wake_word.py --keyword "HEY BART" --keyword "BART"
    python wake_word.py --score 2.0 --threshold 0.1   # keywords more sensitive

Each sentence is saved to recordings/, the terminal prints its length and file
size, and it's sent to the OpenAI Realtime API; the spoken reply streams back
through the speaker. The whole session is one conversation, so follow-ups work.
Saying the quit word plays a falling chime, ends the conversation and goes back
to waiting for the wake phrase. Needs OPENAI_API_KEY in pi/.env; without it,
sentences are only recorded.

Uses sherpa-onnx for both steps: keyword spotting for the wake and quit words
(plain text, no training) and Silero VAD to tell when you stop talking.
Same script runs on a Mac and on the Pi.
"""
import argparse
import base64
import os
import tarfile
import urllib.request
import wave
from contextlib import ExitStack
from datetime import datetime
from pathlib import Path

import numpy as np
import sentencepiece as spm
import sherpa_onnx
import sounddevice as sd
from dotenv import load_dotenv
from openai import OpenAI

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

REALTIME_RATE = 24000  # the Realtime API only takes and returns 24 kHz PCM
INSTRUCTIONS = (
    "You are Jarvis, a reading companion. The user is reading a physical book and talking to you "
    "through a small speaker. Answer directly in one to three short spoken sentences. "
    "Don't announce that you're thinking."
)

parser = argparse.ArgumentParser()
parser.add_argument("--keyword", action="append", help="wake phrase; repeat for several (default: HEY JARVIS, JARVIS)")
parser.add_argument("--quit", action="append", help="phrase that stops listening; repeat for several (default: QUIT)")
parser.add_argument("--score", type=float, default=1.5, help="boost for the keyword; higher = easier to trigger")
parser.add_argument("--threshold", type=float, default=0.15, help="lower = easier to trigger")
parser.add_argument("--silence", type=float, default=0.8, help="seconds of silence that count as you having stopped talking")
parser.add_argument("--device", default="JV801", help="part of the mic/speaker name to use; falls back to the system default if not found")
parser.add_argument("--model", default="gpt-realtime-2.1-mini", help="OpenAI Realtime model")
parser.add_argument("--voice", default="marin", help="OpenAI voice for replies")
args = parser.parse_args()
keywords = [k.upper() for k in args.keyword or ["HEY JARVIS", "JARVIS"]]
quit_words = [k.upper() for k in args.quit or ["QUIT"]]
WAKE = {k.replace(" ", "_") for k in keywords}
QUIT = {k.replace(" ", "_") for k in quit_words}


def find_device(kind):
    # The JV801 shows up as two devices (mic and speaker), so match by name per direction
    for i, d in enumerate(sd.query_devices()):
        if args.device.lower() in d["name"].lower() and d[f"max_{kind}_channels"] > 0:
            return i
    print(f"no {kind} device matching {args.device!r}, using the system default")
    return None


mic_device = find_device("input")
speaker_device = find_device("output")

# Play replies at 24 kHz if the speaker takes it, otherwise resample to its own rate
try:
    sd.check_output_settings(device=speaker_device, samplerate=REALTIME_RATE, channels=1, dtype="int16")
    play_rate = REALTIME_RATE
except sd.PortAudioError:
    play_rate = int(sd.query_devices(speaker_device, "output")["default_samplerate"])

load_dotenv(HERE / ".env")
client = OpenAI() if os.environ.get("OPENAI_API_KEY") else None
if not client:
    print("no OPENAI_API_KEY in pi/.env, so sentences are only recorded")


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
    lines = [f"{' '.join(sp.encode(k, out_type=str))} @{k.replace(' ', '_')}" for k in keywords + quit_words]
    path = MODELS_DIR / "keywords.txt"
    path.write_text("\n".join(lines) + "\n")
    return path


def chime(freqs):
    # Two beeps, generated so there's no sound file to ship: rising = listening, falling = stopped
    rate = int(sd.query_devices(speaker_device, "output")["default_samplerate"])
    t = np.arange(int(rate * 0.12)) / rate
    fade = np.minimum(1, np.minimum(t, t[::-1]) / 0.01)
    beeps = [0.3 * np.sin(2 * np.pi * f * t) * fade for f in freqs]
    sd.play(np.concatenate([beeps[0], np.zeros(int(rate * 0.04)), beeps[1]]).astype(np.float32), rate, device=speaker_device)
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


def resample(x, src, dst):
    # Linear interpolation is plenty for speech
    n = int(len(x) * dst / src)
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)


def open_conversation():
    session = ExitStack()
    conn = session.enter_context(client.realtime.connect(model=args.model))
    # Our VAD decides when you've stopped talking, so the server's turn detection is off
    conn.session.update(session={
        "type": "realtime",
        "instructions": INSTRUCTIONS,
        "output_modalities": ["audio"],
        "audio": {
            "input": {
                "format": {"type": "audio/pcm", "rate": REALTIME_RATE},
                "turn_detection": None,
                "transcription": {"model": "gpt-4o-mini-transcribe"},
            },
            "output": {"format": {"type": "audio/pcm", "rate": REALTIME_RATE}, "voice": args.voice},
        },
    })
    return session, conn


def ask(conn, samples):
    pcm = (np.clip(resample(samples, SAMPLE_RATE, REALTIME_RATE), -1, 1) * 32767).astype(np.int16)
    conn.input_audio_buffer.append(audio=base64.b64encode(pcm.tobytes()).decode())
    conn.input_audio_buffer.commit()
    conn.response.create()
    # Play each chunk as it arrives instead of waiting for the whole reply
    with sd.OutputStream(device=speaker_device, samplerate=play_rate, channels=1, dtype="int16") as out:
        for event in conn:
            if event.type == "response.output_audio.delta":
                chunk = np.frombuffer(base64.b64decode(event.delta), dtype=np.int16)
                if play_rate != REALTIME_RATE:
                    chunk = resample(chunk, REALTIME_RATE, play_rate).astype(np.int16)
                out.write(chunk.reshape(-1, 1))
            elif event.type == "conversation.item.input_audio_transcription.completed":
                print(f"  you: {event.transcript.strip()}")
            elif event.type == "response.output_audio_transcript.done":
                print(f"  jarvis: {event.transcript.strip()}")
            elif event.type == "error":
                print(f"  openai error: {event.error.message}")
                break
            elif event.type == "response.done":
                break


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

with sd.InputStream(device=mic_device, samplerate=SAMPLE_RATE, channels=1, dtype="float32", blocksize=FRAME) as mic:
    print(f"mic: {sd.query_devices(mic_device, 'input')['name']}, "
          f"speaker: {sd.query_devices(speaker_device, 'output')['name']}")
    print(f"waiting for {' / '.join(keywords)}...")
    listening = speaking = False
    pending = np.zeros(0, dtype=np.float32)
    session = conn = None
    while True:
        frame, _ = mic.read(FRAME)
        frame = np.squeeze(frame)

        # The spotter always runs: it hears the wake words while waiting and the quit words while listening
        heard = None
        stream.accept_waveform(SAMPLE_RATE, frame)
        while spotter.is_ready(stream):
            spotter.decode_stream(stream)
            if keyword := spotter.get_result(stream):
                spotter.reset_stream(stream)
                heard = keyword

        if not listening:
            if heard in WAKE:
                print(f"heard {heard}, listening until you say {' / '.join(quit_words)}...")
                chime((660, 990))
                mic.read(mic.read_available)  # drop audio captured during the chime
                vad.reset()
                pending = np.zeros(0, dtype=np.float32)
                listening, speaking = True, False
                if client:
                    session, conn = open_conversation()  # mic keeps buffering meanwhile, so nothing is lost
            continue

        if heard in QUIT:
            # Stop before the VAD finishes this utterance, so "quit" itself isn't saved
            print(f"heard {heard}, stopped listening")
            if session:
                session.close()
                session = conn = None
            chime((990, 660))
            mic.read(mic.read_available)
            listening = False
            print(f"waiting for {' / '.join(keywords)}...")
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
            speaking = False
            if conn:
                ask(conn, samples)
                # Throw away what the mic heard while we waited and while the reply played
                mic.read(mic.read_available)
                vad.reset()
                pending = np.zeros(0, dtype=np.float32)
                spotter.reset_stream(stream)
