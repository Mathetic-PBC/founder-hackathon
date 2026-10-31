"""Wait for the wake phrase, chime, then record each sentence you say until you say "quit".

    python wake_word.py                       # wake: "HEY BART", stop: "QUIT"
    python wake_word.py --keyword "HEY BART" --keyword "BART"
    python wake_word.py --score 2.0 --threshold 0.1   # keywords more sensitive

Each sentence is saved to recordings/, the terminal prints its length and file
size, and it's sent to the OpenAI Realtime API; the spoken reply streams back
through the speaker. The whole session is one conversation, so follow-ups work.
Saying the quit word plays a falling chime, ends the conversation and goes back
to waiting for the wake phrase. Needs OPENAI_API_KEY in pi/.env; without it,
sentences are only recorded. With BART_URL and BART_TOKEN too, the model can call
Bart's agents (see agents.py); their results come back into the conversation.

Uses sherpa-onnx for both steps: keyword spotting for the wake and quit words
(plain text, no training) and Silero VAD to tell when you stop talking.
Same script runs on a Mac and on the Pi.
"""
import argparse
import base64
import os
import tarfile
import time
import threading
import logging
import math
import subprocess
import sys
from collections import deque
import urllib.request
from contextlib import ExitStack
from pathlib import Path

import numpy as np
import sherpa_onnx
import wake as hardware
sd = hardware.sd  # Sets the Pi's application-local ALSA config before PortAudio loads.
from dotenv import load_dotenv
from openai import OpenAI

import agents

SAMPLE_RATE = 16000
FRAME = 1280  # 80 ms

HERE = Path(__file__).resolve().parent
cfg = hardware.Config.from_env()
os.umask(0o077)
logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                    format="%(asctime)s %(levelname)s %(message)s")
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
    "You are Bart, a reading companion. The user is reading a physical book and talking to you "
    "through a small speaker. Answer directly in one to three short spoken sentences. "
    "Don't announce that you're thinking."
)

parser = argparse.ArgumentParser()
parser.add_argument("--keyword", action="append", help="wake phrase; repeat for several (default: HEY BART)")
parser.add_argument("--quit", action="append", help="phrase that stops listening; repeat for several (default: QUIT)")
parser.add_argument("--score", type=float, default=cfg.score, help="boost for the keyword; higher = easier to trigger")
parser.add_argument("--threshold", type=float, default=cfg.threshold, help="lower = easier to trigger")
parser.add_argument("--silence", type=float, default=cfg.silence, help="seconds of silence that count as you having stopped talking")
parser.add_argument("--device", help="name substring overriding MIC_DEVICE and SPEAKER_DEVICE; no default-device fallback")
parser.add_argument("--model", default=os.getenv("REALTIME_MODEL", "gpt-realtime-2.1-mini"), help="OpenAI Realtime model")
parser.add_argument("--voice", default=os.getenv("REALTIME_VOICE", "marin"), help="OpenAI voice for replies")
parser.add_argument("--idle", type=float, default=float(os.getenv("IDLE_SECONDS", "30")), help="seconds of silence after which it stops listening, like saying quit")
parser.add_argument("--check", action="store_true", help="load models and validate USB audio, then exit")
args = parser.parse_args()
keywords = [k.upper() for k in args.keyword or ["HEY BART"]]
quit_words = [k.upper() for k in args.quit or ["QUIT"]]
WAKE = {k.replace(" ", "_") for k in keywords}
QUIT = {k.replace(" ", "_") for k in quit_words}


def find_device(kind):
    return hardware.device_name(args.device or (cfg.mic if kind == "input" else cfg.speaker), kind)


mic_device = find_device("input")
speaker_device = find_device("output")

# Play replies at 24 kHz if the speaker takes it, otherwise resample to its own rate
try:
    if speaker_device.startswith("bart_"):
        # PortAudio's format probe falsely rejects ALSA plug resampling.
        play_rate = REALTIME_RATE
    else:
        sd.check_output_settings(device=speaker_device, samplerate=REALTIME_RATE, channels=1, dtype="int16")
        play_rate = REALTIME_RATE
except sd.PortAudioError:
    play_rate = int(sd.query_devices(speaker_device, "output")["default_samplerate"])

load_dotenv(HERE / ".env")
client = OpenAI(timeout=30, max_retries=2) if os.environ.get("OPENAI_API_KEY") else None
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
    text = MODELS_DIR / "agents-keywords.txt"
    text.write_text("\n".join(f"{k} @{k.replace(' ', '_')}" for k in keywords + quit_words) + "\n")
    path = MODELS_DIR / "agents-keyword-tokens.txt"
    subprocess.run([str(Path(sys.executable).parent / "sherpa-onnx-cli"), "text2token",
                    "--tokens", str(KWS_DIR / "tokens.txt"), "--tokens-type", "bpe",
                    "--bpe-model", str(KWS_DIR / "bpe.model"), str(text), str(path)], check=True)
    return path


def chime(freqs):
    # Two beeps, generated so there's no sound file to ship: rising = listening, falling = stopped
    hardware.prepare_speaker(cfg)
    rate = SAMPLE_RATE if speaker_device.startswith("bart_") else int(sd.query_devices(speaker_device, "output")["default_samplerate"])
    t = np.arange(int(rate * 0.12)) / rate
    fade = np.minimum(1, np.minimum(t, t[::-1]) / 0.01)
    beeps = [cfg.volume * np.sin(2 * np.pi * f * t) * fade for f in freqs]
    sd.play(np.concatenate([beeps[0], np.zeros(int(rate * 0.04)), beeps[1]]).astype(np.float32), rate, device=speaker_device)
    sd.wait()


def save(samples):
    return hardware.save_wav(samples[:int(cfg.maximum * SAMPLE_RATE)])


def resample(x, src, dst):
    # Linear interpolation is plenty for speech
    n = int(len(x) * dst / src)
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)


def open_conversation():
    session = ExitStack()
    conn = session.enter_context(client.realtime.connect(model=args.model))
    tools, tool_instructions = agents.start()
    # Our VAD decides when you've stopped talking, so the server's turn detection is off
    conn.session.update(session={
        "type": "realtime",
        "instructions": INSTRUCTIONS + tool_instructions,
        "tools": tools,
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


def speech(text):
    # A short spoken phrase as 24 kHz PCM, made once with text-to-speech and kept in models/
    path = MODELS_DIR / f"say-{args.voice}-{''.join(c for c in text.lower() if c.isalnum())}.pcm"
    if not path.exists():
        path.write_bytes(client.audio.speech.create(model="gpt-4o-mini-tts", voice=args.voice, input=text, response_format="pcm").read())
    chunk = np.frombuffer(path.read_bytes(), dtype=np.int16)
    return resample(chunk, REALTIME_RATE, play_rate).astype(np.int16) if play_rate != REALTIME_RATE else chunk


def tick(out, n):
    # Short beep on the reply stream: each second of the camera countdown, and higher as the photo is taken
    t = np.arange(int(play_rate * 0.1)) / play_rate
    out.write((0.3 * 32767 * np.sin(2 * np.pi * (880 if n else 1320) * t)).astype(np.int16).reshape(-1, 1))


# Bart can also speak unprompted (research on something marked in red). Replies and those announcements
# take turns on the speaker, and the mic is ignored while Bart talks so it doesn't hear itself.
speaker_lock = threading.Lock()
bart_talking = threading.Event()


def say(text):
    with speaker_lock:
        hardware.prepare_speaker(cfg)
        bart_talking.set()
        try:
            pcm = client.audio.speech.create(model="gpt-4o-mini-tts", voice=args.voice, input=text, response_format="pcm").read()
            chunk = np.frombuffer(pcm, dtype=np.int16)
            if play_rate != REALTIME_RATE:
                chunk = resample(chunk, REALTIME_RATE, play_rate).astype(np.int16)
            print(f"  bart (unprompted): {text}")
            sd.play(chunk, play_rate, device=speaker_device)
            sd.wait()
        except Exception as e:
            print(f"  couldn't say it out loud ({e}): {text}")
        finally:
            bart_talking.clear()


if client:
    agents.configure(say=say)


def ask(conn, samples):
    hardware.prepare_speaker(cfg)
    agents.deliver(conn)
    pcm = (np.clip(resample(samples, SAMPLE_RATE, REALTIME_RATE), -1, 1) * 32767).astype(np.int16)
    conn.input_audio_buffer.append(audio=base64.b64encode(pcm.tobytes()).decode())
    conn.input_audio_buffer.commit()
    conn.response.create()
    # Play each chunk as it arrives instead of waiting for the whole reply
    with speaker_lock, sd.OutputStream(device=speaker_device, samplerate=play_rate, channels=1, dtype="int16") as out:
        for event in conn:
            if event.type == "response.output_audio.delta":
                chunk = np.frombuffer(base64.b64decode(event.delta), dtype=np.int16)
                if play_rate != REALTIME_RATE:
                    chunk = resample(chunk, REALTIME_RATE, play_rate).astype(np.int16)
                out.write(chunk.reshape(-1, 1))
            elif event.type == "conversation.item.input_audio_transcription.completed":
                print(f"  you: {event.transcript.strip()}")
            elif event.type == "response.output_audio_transcript.done":
                print(f"  bart: {event.transcript.strip()}")
            elif event.type == "error":
                print(f"  openai error: {event.error.message}")
                break
            elif event.type == "response.done":
                # Tool calls: run the agents, return their results, keep playing the follow-up reply
                captured = lambda: out.write(speech("Captured.").reshape(-1, 1))
                if agents.handle(conn, event.response, on_countdown=lambda n: tick(out, n), on_captured=captured):
                    continue
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
vad_config.silero_vad.max_speech_duration = cfg.maximum
vad_config.sample_rate = SAMPLE_RATE
vad = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=60)
VAD_WINDOW = vad_config.silero_vad.window_size

if args.check:
    with sd.InputStream(device=mic_device, samplerate=SAMPLE_RATE, channels=1, dtype="float32") as mic:
        mic.read(FRAME)
    with sd.OutputStream(device=speaker_device, samplerate=play_rate, channels=1, dtype="int16"):
        pass
    print(f"Ready: sherpa-onnx score={args.score} threshold={args.threshold}; {mic_device}; Silero VAD; Realtime SDK")
    raise SystemExit(0)


def listen():
    stream = spotter.create_stream()
    vad.reset()
    capture = hardware.Microphone()
    history = deque(maxlen=math.ceil(cfg.pre_roll * SAMPLE_RATE / FRAME))
    session = conn = None
    try:
        with sd.InputStream(device=mic_device, samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                                blocksize=FRAME, callback=capture.callback):
            print(f"mic: {sd.query_devices(mic_device, 'input')['name']}, "
                  f"speaker: {sd.query_devices(speaker_device, 'output')['name']}")
            print(f"waiting for {' / '.join(keywords)}...")
            listening = speaking = False
            last_heard = time.monotonic()  # last time anyone spoke, for the --idle timeout
            pending = np.zeros(0, dtype=np.float32)
            while True:
                frame = capture.read()
                history.append(frame)
                if bart_talking.is_set():
                    last_heard = time.monotonic()
                    continue  # Bart is speaking unprompted; don't let the mic hear it

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
                        vad.reset()
                        pending = np.concatenate(history) if history else np.zeros(0, dtype=np.float32)
                        listening, speaking = True, False
                        last_heard = time.monotonic()
                    continue

                # Saying the quit word, or a stretch of silence, ends the conversation; the wake word starts a new one
                timed_out = listening and not speaking and time.monotonic() - last_heard > args.idle
                if heard in QUIT or timed_out:
                    # Stop before the VAD finishes this utterance, so "quit" itself isn't saved
                    print(f"heard {heard}, stopped listening" if heard in QUIT else f"{args.idle:g} s of silence, stopped listening")
                    if session:
                        session.close()
                        session = conn = None
                    agents.stop()  # turn the camera off if an agent left it on
                    chime((990, 660))
                    capture.clear()
                    history.clear()
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
                    last_heard = time.monotonic()
                    print("  you're talking...")
                if not vad.empty():
                    samples = np.array(vad.front.samples, dtype=np.float32)[:int(cfg.maximum * SAMPLE_RATE)]
                    vad.pop()
                    path = save(samples)
                    print(f"  you stopped talking: {len(samples) / SAMPLE_RATE:.1f} s, "
                          f"{path.stat().st_size / 1024:.1f} KB -> {path.relative_to(HERE)}")
                    speaking = False
                    last_heard = time.monotonic()
                    if client:
                        # Connect only after saving the question, so a slow network cannot
                        # overrun the mic queue and cut off its start.
                        if conn is None:
                            for attempt in range(3):
                                try:
                                    session, conn = open_conversation()
                                    break
                                except Exception as exc:
                                    print(f"  Realtime connection failed ({type(exc).__name__}), attempt {attempt + 1}/3")
                                    if attempt < 2:
                                        time.sleep(2 ** attempt)
                        if conn:
                            try:
                                ask(conn, samples)
                            except Exception as exc:
                                print(f"  Realtime turn failed ({type(exc).__name__}); WAV kept")
                                if session:
                                    session.close()
                                session = conn = None
                        last_heard = time.monotonic()
                        capture.clear()
                        history.clear()
                        vad.reset()
                        pending = np.zeros(0, dtype=np.float32)
                        spotter.reset_stream(stream)

    finally:
        if session:
            session.close()
        agents.stop()


while True:
    try:
        listen()
    except KeyboardInterrupt:
        agents.stop()
        break
    except Exception as exc:
        print(f"listener failed ({type(exc).__name__}); retrying in 3s")
        agents.stop()
        time.sleep(3)
