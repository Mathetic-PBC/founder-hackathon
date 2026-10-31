#!/usr/bin/env python3
"""HEY BART -> chime -> one 16 kHz question -> optional HTTP turn -> listen."""

from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
import logging
import math
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import time
import uuid
import wave

import numpy as np
import requests
import sherpa_onnx
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
# PortAudio reads ALSA configuration when sounddevice is imported. This local
# plug PCM converts the JV801's native 48 kHz capture to 16 kHz without changing
# the user's system audio configuration.
if sys.platform.startswith("linux"):
    os.environ.setdefault("ALSA_CONFIG_PATH", str(HERE / "alsa.conf"))
import sounddevice as sd

MODEL = HERE / "models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
CHUNK = "epoch-12-avg-2-chunk-16-left-64"
RATE = 16000
BLOCK = 1600  # 100 ms
LOG = logging.getLogger("bart")


@dataclass(frozen=True)
class Config:
    mic: str = "JV801"
    speaker: str = "JV801"
    score: float = 1.5
    threshold: float = 0.15
    vad: float = 0.015
    silence: float = 1.5
    maximum: float = 15.0
    start_timeout: float = 5.0
    pre_roll: float = 0.6
    volume: float = 0.15
    turn_url: str = ""
    attempts: int = 3
    connect_timeout: float = 5.0
    read_timeout: float = 30.0

    @classmethod
    def from_env(cls):
        load_dotenv(HERE / ".env")
        cfg = cls(
            mic=os.getenv("MIC_DEVICE", "JV801"),
            speaker=os.getenv("SPEAKER_DEVICE", "JV801"),
            score=float(os.getenv("KEYWORDS_SCORE", "1.5")),
            threshold=float(os.getenv("KEYWORDS_THRESHOLD", "0.15")),
            vad=float(os.getenv("VAD_THRESHOLD", "0.015")),
            silence=float(os.getenv("SILENCE_SECONDS", "1.5")),
            maximum=float(os.getenv("MAX_RECORD_SECONDS", "15")),
            start_timeout=float(os.getenv("SPEECH_START_TIMEOUT", "5")),
            pre_roll=float(os.getenv("PRE_ROLL_SECONDS", "0.6")),
            volume=float(os.getenv("CHIME_VOLUME", "0.15")),
            turn_url=os.getenv("TURN_URL", "").strip(),
            attempts=int(os.getenv("HTTP_ATTEMPTS", "3")),
            connect_timeout=float(os.getenv("HTTP_CONNECT_TIMEOUT", "5")),
            read_timeout=float(os.getenv("HTTP_READ_TIMEOUT", "30")),
        )
        if not cfg.mic.strip() or not cfg.speaker.strip():
            raise ValueError("MIC_DEVICE and SPEAKER_DEVICE must name the USB device")
        for value in (cfg.score, cfg.threshold, cfg.vad, cfg.silence, cfg.maximum,
                      cfg.start_timeout, cfg.pre_roll, cfg.volume,
                      cfg.connect_timeout, cfg.read_timeout):
            if not math.isfinite(value):
                raise ValueError("Configuration numbers must be finite")
        if not (cfg.score > 0 and 0 < cfg.threshold <= 1 and 0 < cfg.vad < 1):
            raise ValueError("Invalid keyword score/threshold or VAD threshold")
        if not (0 < cfg.silence <= cfg.maximum <= 15 and
                0 < cfg.start_timeout <= cfg.maximum and
                0 <= cfg.pre_roll <= 2 and cfg.pre_roll < cfg.maximum and
                0 <= cfg.volume <= 0.5 and 1 <= cfg.attempts <= 5 and
                cfg.connect_timeout > 0 and cfg.read_timeout > 0):
            raise ValueError("Invalid timing/volume/retry settings (recording cap is 15s)")
        if cfg.turn_url and not cfg.turn_url.startswith(("http://", "https://")):
            raise ValueError("TURN_URL must be an HTTP(S) URL")
        return cfg


def device_name(substring, kind):
    """Return a name, never a persisted/index-based device selection."""
    matches = [d["name"] for d in sd.query_devices()
               if substring.casefold() in d["name"].casefold()
               and d[f"max_{kind}_channels"] > 0]
    # Prefer our named conversion PCM over the same card's raw hardware entry.
    # Debian PortAudio's IsFormatSupported rejects 16 kHz on plug PCMs even
    # though opening/reading/writing the streams succeeds. Validate by opening.
    converted = [name for name in matches if name.startswith("bart_")]
    if converted:
        matches = converted
    if len(matches) != 1:
        raise RuntimeError(f"Expected one 16 kHz {kind} device matching {substring!r}; found {matches}")
    return matches[0]


class Microphone:
    """Keep capturing while chime/inference runs, so question onset isn't lost."""

    def __init__(self):
        self.blocks = queue.Queue(maxsize=40)
        self.overruns = 0

    def callback(self, data, frames, timing, status):
        # No logging, file I/O or inference on PortAudio's real-time callback.
        if status:
            self.overruns += 1
        block = data[:, 0].copy()
        try:
            self.blocks.put_nowait(block)
        except queue.Full:
            self.overruns += 1
            try:
                self.blocks.get_nowait()
            except queue.Empty:
                pass
            self.blocks.put_nowait(block)

    def read(self):
        try:
            return self.blocks.get(timeout=3)
        except queue.Empty as exc:
            raise RuntimeError("USB microphone stopped delivering audio") from exc

    def clear(self):
        while True:
            try:
                self.blocks.get_nowait()
            except queue.Empty:
                break
        self.overruns = 0


class Utterance:
    """Sample-count endpointing, independent of inference/playback wall time."""

    def __init__(self, cfg, pre_roll):
        self.cfg = cfg
        self.parts = list(pre_roll)
        self.samples = sum(len(p) for p in self.parts)
        self.after_wake = 0
        self.quiet = 0
        self.voiced = False
        self.reason = ""

    def add(self, block):
        block = block[:max(0, int(self.cfg.maximum * RATE) - self.samples)]
        self.parts.append(block)
        self.samples += len(block)
        self.after_wake += len(block)
        # Retain the chime interval, including speech over it, but don't let the
        # speaker's own beep count as speech. Pre-roll may include the wake tail.
        if self.after_wake > int(0.3 * RATE) and len(block):
            rms = float(np.sqrt(np.mean(np.square(block))))
            if rms >= self.cfg.vad:
                self.voiced = True
                self.quiet = 0
            else:
                self.quiet += len(block)
        if self.samples >= int(self.cfg.maximum * RATE):
            self.reason = "15s cap" if self.cfg.maximum == 15 else "duration cap"
        elif self.voiced and self.quiet >= int(self.cfg.silence * RATE):
            self.reason = "silence"
        elif not self.voiced and self.after_wake >= int(self.cfg.start_timeout * RATE):
            self.reason = "no speech timeout"
        return bool(self.reason)

    def audio(self):
        return np.concatenate(self.parts)


def play_pcm(samples, speaker, rate=RATE):
    with sd.OutputStream(device=speaker, samplerate=rate, channels=1, dtype="float32") as output:
        output.write(np.asarray(samples, dtype=np.float32).reshape(-1, 1))


def chime(speaker, volume):
    t = np.arange(int(RATE * 0.12)) / RATE
    envelope = np.minimum(1.0, np.minimum(t, t[::-1]) / 0.008)
    play_pcm(volume * np.sin(2 * np.pi * 880 * t) * envelope, speaker)


def save_wav(samples, directory=HERE / "recordings"):
    directory.mkdir(parents=True, exist_ok=True)
    name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    path = directory / f"{name}-{uuid.uuid4().hex[:8]}.wav"
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(pcm.tobytes())
    LOG.info("got utterance: %s", path)
    return path


def play_mp3(data, speaker):
    # ffmpeg is installed by setup.sh. Bound decoding/playback to two minutes.
    decoded = subprocess.run(
        ["ffmpeg", "-v", "error", "-nostdin", "-i", "pipe:0", "-t", "120",
         "-f", "f32le", "-ac", "1", "-ar", str(RATE), "pipe:1"],
        input=data, capture_output=True, check=True, timeout=30,
    )
    samples = np.frombuffer(decoded.stdout, dtype="<f4")
    if not len(samples):
        raise ValueError("Empty decoded audio reply")
    play_pcm(samples, speaker)


def send_turn(cfg, path, session_id, speaker, http):
    """Bounded retries; the local WAV always survives failed requests/replies."""
    request_id = str(uuid.uuid4())
    for attempt in range(cfg.attempts):
        try:
            with path.open("rb") as audio:
                with http.post(
                    cfg.turn_url,
                    files={"audio": (path.name, audio, "audio/wav")},
                    data={"session_id": session_id},
                    headers={"Idempotency-Key": request_id},
                    timeout=(cfg.connect_timeout, cfg.read_timeout),
                    stream=True,
                    allow_redirects=False,
                ) as response:
                    if response.status_code == 429 or response.status_code >= 500:
                        raise requests.ConnectionError(f"retryable HTTP {response.status_code}")
                    if response.status_code != 200:
                        LOG.warning("Turn returned HTTP %s; WAV kept", response.status_code)
                        return
                    if response.headers.get("Content-Type", "").split(";")[0].strip().lower() != "audio/mpeg":
                        LOG.warning("Turn reply is not audio/mpeg; WAV kept")
                        return
                    reply = bytearray()
                    deadline = time.monotonic() + cfg.read_timeout
                    for part in response.iter_content(65536):
                        reply.extend(part)
                        if len(reply) > 10 * 1024 * 1024:
                            raise ValueError("Audio reply exceeds 10 MB")
                        if time.monotonic() > deadline:
                            raise requests.Timeout("Audio reply deadline exceeded")
            play_mp3(bytes(reply), speaker)
            LOG.info("Played turn reply")
            return
        except requests.RequestException as exc:
            # Avoid logging URLs, response bodies, or credentials from .env.
            LOG.warning("Turn network failure (%s), attempt %d/%d",
                        type(exc).__name__, attempt + 1, cfg.attempts)
            if attempt + 1 < cfg.attempts:
                time.sleep(2 ** attempt)
        except Exception as exc:
            LOG.warning("Turn reply failed (%s); WAV kept", type(exc).__name__)
            return
    LOG.warning("Turn retries exhausted; WAV kept at %s", path)


def make_spotter(cfg):
    return sherpa_onnx.KeywordSpotter(
        tokens=str(MODEL / "tokens.txt"),
        encoder=str(MODEL / f"encoder-{CHUNK}.int8.onnx"),
        decoder=str(MODEL / f"decoder-{CHUNK}.onnx"),
        joiner=str(MODEL / f"joiner-{CHUNK}.int8.onnx"),
        keywords_file=str(HERE / "models/keywords.txt"),
        keywords_score=cfg.score, keywords_threshold=cfg.threshold,
        num_threads=2, num_trailing_blanks=1, provider="cpu",
    )


def listen(cfg, spotter, session_id, http):
    mic = device_name(cfg.mic, "input")
    speaker = device_name(cfg.speaker, "output")
    with sd.OutputStream(device=speaker, samplerate=RATE, channels=1, dtype="float32"):
        pass
    LOG.info("Microphone: %s; speaker: %s", mic, speaker)
    capture = Microphone()
    history = deque(maxlen=math.ceil(cfg.pre_roll * RATE / BLOCK))
    stream = spotter.create_stream()
    with sd.InputStream(device=mic, samplerate=RATE, channels=1, dtype="float32",
                        blocksize=BLOCK, callback=capture.callback):
        LOG.info("Listening for HEY BART")
        while True:
            block = capture.read()
            history.append(block)
            stream.accept_waveform(RATE, block)
            detected = ""
            while spotter.is_ready(stream):
                spotter.decode_stream(stream)
                detected = spotter.get_result(stream)
                if detected:
                    break
            if not detected:
                if capture.overruns:
                    LOG.warning("Microphone overrun; restarting audio")
                    return
                continue
            LOG.info("Wake detected: %s; recording question", detected)
            spotter.reset_stream(stream)
            utterance = Utterance(cfg, history)
            try:
                chime(speaker, cfg.volume)
                LOG.info("Chime played")
            except Exception as exc:
                LOG.warning("Chime failed (%s); continuing recording", type(exc).__name__)
            while not utterance.add(capture.read()):
                pass
            path = save_wav(utterance.audio())
            LOG.info("Recorded %.2fs (%s)", utterance.samples / RATE, utterance.reason)
            if capture.overruns:
                LOG.warning("Audio overrun during recording: %d", capture.overruns)
            if cfg.turn_url:
                send_turn(cfg, path, session_id, speaker, http)
            # Discard reply/processing audio so Bart cannot wake on its own voice.
            capture.clear()
            history.clear()
            stream = spotter.create_stream()
            LOG.info("Listening for HEY BART")


def main():
    os.umask(0o077)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.StreamHandler(sys.stdout)])
    def stop(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    cfg = Config.from_env()
    session_id = str(uuid.uuid4())  # One ID across all turns/reconnects in this process.
    LOG.info("Engine: sherpa-onnx; score=%s threshold=%s; session_id=%s; mode=%s",
             cfg.score, cfg.threshold, session_id, "HTTP turns" if cfg.turn_url else "save only")
    spotter = make_spotter(cfg)
    with requests.Session() as http:
        while True:
            try:
                listen(cfg, spotter, session_id, http)
            except KeyboardInterrupt:
                LOG.info("Stopped")
                return
            except Exception as exc:
                LOG.error("Listener failed (%s): %s; retrying in 3s", type(exc).__name__, exc)
            time.sleep(3)


if __name__ == "__main__":
    main()
