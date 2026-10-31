# Bart on Raspberry Pi

Say **Hey Bart**, hear the chime, then ask a question. The JV801 stays open at
16 kHz mono; a 0.6 s pre-roll and continuous capture through the chime preserve
the question's start (the WAV may include the wake phrase's tail and chime).
After 1.5 s of quiet, or a strict 15 s total cap, a timestamped 16-bit WAV lands
in `pi/recordings/`. With no speech after waking, recording ends after 5 s.

Uses **sherpa-onnx 2.0.1** open-vocabulary keyword spotting on Python 3.13 ARM64,
with the English GigaSpeech 3.3M model. No training or cloud wake-word service.
The official [KWS docs](https://k2-fsa.github.io/sherpa/onnx/kws/index.html) explain
the score and threshold. Setup downloads the [official release model](https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2)
and generates BPE tokens using `sherpa-onnx-cli text2token` and its `bpe.model`.

## Setup and run

On the Pi, as `dbarron` (the Mac's `ssh pi` alias uses this account):

```bash
git clone https://github.com/Mathetic-PBC/founder-hackathon.git ~/founder-hackathon
cd ~/founder-hackathon
bash pi/setup.sh
cd pi
nano .env
venv/bin/python -u wake.py
```

Setup is safe to repeat; it preserves `.env`, recordings, and existing models.
It installs PortAudio, ALSA tools, ffmpeg, a venv, and pinned Python dependencies.
Do not run the whole script with sudo. For a private repo, use an SSH clone URL
with a **read-only** GitHub deploy key on the Pi; never copy Mac credentials.

`MIC_DEVICE` and `SPEAKER_DEVICE` are case-insensitive name substrings, default
`JV801`. There is no fallback to HDMI or to another microphone. Inspect devices
with `ALSA_CONFIG_PATH="$PWD/alsa.conf" venv/bin/python -m sounddevice`.
The JV801's microphone is natively 48 kHz. `alsa.conf` adds `bart_JV801`, an
application-local ALSA plug device that converts to/from 16 kHz mono. Selection
matches the configured name and validates by opening the stream; it never falls back to
an unrelated device or a fixed card index. System audio settings are preserved.
For a different USB card, update the `slave.pcm` card name and hint in this file.
USB startup/disconnect errors retry.

`ALSA_CARD=JV801` and `HARDWARE_VOLUME=75` set the hardware playback volume before
each chime/reply: this Pi's audio manager otherwise restores it to 0% at boot.
`CHIME_VOLUME` adjusts the beep amplitude separately. The venue deployment uses
`CHIME_VOLUME=0.35` and `VAD_THRESHOLD=0.065` because of room noise; defaults in
`.env.example` are quieter and more sensitive for a quiet room.

Tune `KEYWORDS_SCORE=1.5` and `KEYWORDS_THRESHOLD=0.15` in `.env`; a higher score
or lower threshold increases sensitivity. `VAD_THRESHOLD=0.015` is normalized
RMS: increase it if room noise keeps recordings open, decrease it if quiet
speech is missed. `SILENCE_SECONDS=1.5` controls the pause allowed within a
question. Recordings never exceed 15 s. Restart after changing `.env`.

Set `TURN_URL` later to POST multipart `audio` (WAV) plus `session_id` (one UUID
per process). A successful `200 audio/mpeg` reply plays through the JV801 using
ffmpeg and sounddevice. Network/429/5xx failures retry up to three times with
1 s and 2 s backoff. Failed turns keep their WAV and return to listening; they
are not queued for later upload. Requests include an `Idempotency-Key` reused
across retries; the endpoint must honor it to prevent duplicate processing.
The listener pauses wake detection while a turn/reply is in progress.

`.env`, venvs, recordings and downloaded models are ignored by Git. Recordings
accumulate locally; remove ones you no longer need to free disk space.

## Start at boot (user service)

Stop a manual listener with Ctrl-C before starting the service:

```bash
mkdir -p ~/.config/systemd/user
cp ~/founder-hackathon/pi/bart.service ~/.config/systemd/user/bart.service
systemctl --user daemon-reload
systemctl --user enable --now bart
sudo loginctl enable-linger dbarron
sudo mkdir -p /etc/systemd/journald.conf.d
sudo cp ~/founder-hackathon/pi/bart-journald.conf /etc/systemd/journald.conf.d/60-bart.conf
sudo systemctl restart systemd-journald
sudo journalctl --flush
journalctl --user -u bart -f
```

Linger starts the user service at boot without an interactive login. The unit
uses the Pi user's audio permissions and restarts failures after three seconds.
The journald drop-in enables persistent logs (bounded to 64 MB / seven days),
needed for `journalctl --user` on this Pi OS image. For a test with no interactive
login, disable automatic desktop/console login with
`sudo raspi-config nonint do_boot_behaviour B3`, then `sudo reboot`. The desktop
login screen remains available; Wi-Fi configuration is unchanged.

## Update from the Mac

```bash
ssh pi 'cd ~/founder-hackathon && git pull --ff-only && systemctl --user restart bart'
```

If requirements or setup changed, run `bash pi/setup.sh` before restarting.
If the unit changed, copy it again and run `systemctl --user daemon-reload`.
Check `ssh pi 'journalctl --user -u bart -b -n 40 --no-pager'` after a reboot.

## Hardware checks

Keep the Pi on the iPhone hotspot. Use the ALSA **card name**, never a card index:

```bash
arecord -l
arecord -D plughw:CARD=JV801,DEV=0 -f S16_LE -r 16000 -c 1 -d 3 ~/audio-test.wav
aplay -D plughw:CARD=JV801,DEV=0 ~/audio-test.wav
rpicam-hello --list-cameras
rpicam-still --nopreview -o ~/test.jpg
```

The camera should list `imx708`. From the Mac: `scp pi:~/test.jpg ./test.jpg`.
The camera is only verified; it is not used by the recorder.
