# pi

Say the wake phrase, hear a rising chime, then talk. Each time you stop talking, the sentence is saved, sent to the [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime), and the spoken reply plays through the speaker as it streams back. It's one conversation until you say "quit", so follow-ups like "can you use that word in a sentence?" work. Saying "quit" plays a falling chime and goes back to waiting for the wake phrase.

```
mic: JOUNIVO JV801, speaker: JOUNIVO JV801
waiting for HEY JARVIS / JARVIS...
heard HEY_JARVIS, listening until you say QUIT...
  you're talking...
  you stopped talking: 2.6 s, 81.9 KB -> recordings/20261030-181536-891889.wav
  you: What does the author mean by the word ephemeral on this page?
  jarvis: "Ephemeral" generally means short-lived or temporary. ...
  you're talking...
  you stopped talking: 1.8 s, 55.9 KB -> recordings/20261030-181539-811519.wav
  you: Can you use that word in a sentence?
  jarvis: Sure! A rainbow is a perfect example of something ephemeral...
heard QUIT, stopped listening
waiting for HEY JARVIS / JARVIS...
```

Listening runs on the device with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx): keyword spotting for the wake and quit words (plain text, so no model to train) and Silero VAD to tell when you've stopped talking. Only finished sentences go to OpenAI, so the room isn't streamed while it's waiting.

## Setup (Mac or Pi)

```bash
# Pi only: audio library for sounddevice
sudo apt install -y libportaudio2

python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
echo 'OPENAI_API_KEY=sk-...' > .env   # git-ignored
python wake_word.py   # say "hey jarvis", wait for the chime, talk, then say "quit"
```

The first run downloads the models (~3 MB keyword model, ~0.6 MB VAD) into `models/`. On a Mac, it also asks for microphone access for your terminal. Recordings are saved as 16 kHz mono WAV in `recordings/`; both folders are git-ignored. Without a key in `.env`, sentences are only recorded.

## Try it on a Mac first

```bash
pi/run-mac.sh            # "hey bart" or "hey jarvis", talk, "quit" to stop
pi/run-mac.sh --check    # set up and test the server and webcam without listening
```

It sets up the venv (plus OpenCV for the webcam), fills `pi/.env` from `web/.env.local`, and starts `web/` on localhost:3000 if it isn't running. The Mac's mic, speaker and webcam stand in for the puck and the Camera Module. `--image photo.jpg` sends a file instead of using the webcam. `--engelbart` mirrors notes into the Engelbart project's "Reading notes" folder. The first run asks for microphone and camera access for your terminal; if the camera was just allowed, run it again.

## Agents

With two more lines in `.env`, the model can call Bart's agents (the `web/` app) mid-conversation:

```bash
BART_URL=https://<app>.vercel.app  # or http://<laptop LAN IP>:3000 while web/ runs on a laptop
BART_TOKEN=...                     # same value as BART_TOKEN in web/.env.local
VAULT_DIR=~/bart-vault             # optional: where notes are mirrored (default pi/vault/)
```

`agents.py` fetches the tool list when a conversation opens. When a reply ends in a tool call, it runs the agent and sends the result back, and the follow-up reply plays like any other. Each call prints a line like `agent: sync_book({}) -> done: {...}`.

The camera works two ways, depending on the agent:

- **Countdown** (sync or delete a book): three beeps, then the photo.
- **On command** (save or share a passage): Bart says it's turning on the camera; when you say "take the photo", a higher beep plays as the photo is taken.

Photos come from the Camera Module 3 through `picamera2`, which comes preinstalled on Raspberry Pi OS but isn't on PyPI. So on the Pi, create the venv with `python3 -m venv --system-site-packages .venv`. On a laptop, set `BART_TEST_IMAGE=cover.jpg` to send a file instead.

After each agent call, the reading notes are mirrored in the background into `VAULT_DIR`: one folder per book, one markdown file per reading session, and photos in `attachments/`. `python vault.py --watch` keeps a mirror running by itself.

Test the agents without the mic or wake word, through the same realtime session. Each argument is one turn:

```bash
BART_TEST_IMAGE=cover.jpg python test_agents.py "I'm starting a new book" "I'm on page 15"
BART_TEST_IMAGE=boxed.jpg python test_agents.py "save what I boxed" "take the photo"
python test_agents.py --wav recordings/<file>.wav
```

## Options

- `--device` (default `JV801`): part of the mic/speaker name to use. The JV801 puck is picked automatically when it's plugged in, for both the mic and the chime; otherwise it falls back to the system default. `python -m sounddevice` lists device names.
- `--model` (default `gpt-realtime-2.1-mini`) and `--voice` (default `marin`): the OpenAI Realtime model and voice.
- `--keyword` replaces the default wake phrases and can be repeated: `--keyword "HEY BART" --keyword "BART"`.
- `--quit` replaces the default stop word (`QUIT`) and can be repeated: `--quit "QUIT" --quit "STOP LISTENING"`.
- `--threshold` (default 0.15): lower it if the wake phrase misses you, raise it if it fires on other speech.
- `--score` (default 1.5): boost for the wake phrase. Raise it if it misses you.
- `--silence` (default 0.8): seconds of quiet that count as you having stopped talking. Raise it if it cuts you off mid-sentence.

Tune these with real people talking at the demo table, not in a quiet room.

A single word ("JARVIS", "BART") is less reliable than the two-word phrase: it gives the model less to go on. In tests with synthesized voices, "HEY BART" was caught every time and "BART" about half the time, and raising the sensitivity only added false triggers. Use the two-word phrase in the demo. "QUIT" has the same limitation: when it's missed, the word is saved as a short recording and it keeps listening, so just say it again.

"QUIT" is spotted anywhere, so a sentence like "why did he quit his job?" also stops listening.

If opening the mic at 16 kHz fails on the Pi, run `python -m sounddevice` to check the speakerphone is listed and what it supports.
