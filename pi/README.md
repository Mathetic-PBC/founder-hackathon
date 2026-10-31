# pi

Say the wake phrase, hear a rising chime, then talk. Each time you stop talking, the terminal prints how long you spoke and the size of the saved audio file, and keeps listening for your next sentence. Say "quit" to stop: a falling chime plays and it goes back to waiting for the wake phrase.

```
mic: JOUNIVO JV801, speaker: JOUNIVO JV801
waiting for HEY JARVIS / JARVIS...
heard HEY_JARVIS, listening until you say QUIT...
  you're talking...
  you stopped talking: 2.6 s, 81.9 KB -> recordings/20261030-180906-725710.wav
  you're talking...
  you stopped talking: 2.2 s, 69.9 KB -> recordings/20261030-180906-771144.wav
heard QUIT, stopped listening
waiting for HEY JARVIS / JARVIS...
```

Everything runs on the device with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx): keyword spotting for the wake and quit words (plain text, so no model to train) and Silero VAD to tell when you've stopped talking. No account or key.

## Setup (Mac or Pi)

```bash
# Pi only: audio library for sounddevice
sudo apt install -y libportaudio2

python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python wake_word.py   # say "hey jarvis", wait for the chime, talk, then say "quit"
```

The first run downloads the models (~3 MB keyword model, ~0.6 MB VAD) into `models/`. On a Mac, it also asks for microphone access for your terminal. Recordings are saved as 16 kHz mono WAV in `recordings/`; both folders are git-ignored.

## Options

- `--device` (default `JV801`): part of the mic/speaker name to use. The JV801 puck is picked automatically when it's plugged in, for both the mic and the chime; otherwise it falls back to the system default. `python -m sounddevice` lists device names.
- `--keyword` replaces the default wake phrases and can be repeated: `--keyword "HEY BART" --keyword "BART"`.
- `--quit` replaces the default stop word (`QUIT`) and can be repeated: `--quit "QUIT" --quit "STOP LISTENING"`.
- `--threshold` (default 0.15): lower it if the wake phrase misses you, raise it if it fires on other speech.
- `--score` (default 1.5): boost for the wake phrase. Raise it if it misses you.
- `--silence` (default 0.8): seconds of quiet that count as you having stopped talking. Raise it if it cuts you off mid-sentence.

Tune these with real people talking at the demo table, not in a quiet room.

A single word ("JARVIS", "BART") is less reliable than the two-word phrase: it gives the model less to go on. In tests with synthesized voices, "HEY BART" was caught every time and "BART" about half the time, and raising the sensitivity only added false triggers. Use the two-word phrase in the demo. "QUIT" has the same limitation: when it's missed, the word is saved as a short recording and it keeps listening, so just say it again.

"QUIT" is spotted anywhere, so a sentence like "why did he quit his job?" also stops listening.

If opening the mic at 16 kHz fails on the Pi, run `python -m sounddevice` to check the speakerphone is listed and what it supports.
