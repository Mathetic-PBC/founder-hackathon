# pi

Wake-word detection with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) keyword spotting. The wake phrases are plain text ("HEY BART" or just "BART"), so there's no model to train, and no account or key.

## Setup (Mac or Pi)

```bash
# Pi only: audio library for sounddevice
sudo apt install -y libportaudio2

python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python wake_word.py   # say "hey bart" or "bart"
```

The first run downloads the ~3 MB English keyword model into `models/`. On a Mac, it also asks for microphone access for your terminal.

## Tuning

Two knobs, both on the command line:

- `--score` (default 1.5): boost for the keyword. Raise it if it misses you.
- `--threshold` (default 0.15): lower it if it misses you, raise it if it fires on other speech.

Tune these with real people talking at the demo table, not in a quiet room.

`--keyword` replaces the defaults and can be repeated: `--keyword "HEY JARVIS" --keyword "JARVIS"`.

"BART" on its own is less reliable than "HEY BART": a single short word gives the model less to go on. In tests with synthesized voices, "HEY BART" was caught every time and "BART" about half the time, and raising the sensitivity only added false triggers. "HEY BART" is the one to use in the demo.

If opening the mic at 16 kHz fails on the Pi, run `python -m sounddevice` to check the speakerphone is listed and what it supports.
