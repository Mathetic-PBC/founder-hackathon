# pi

Wake-word detection with [openWakeWord](https://github.com/dscripka/openWakeWord). No account or key needed.

## Mac

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install openwakeword sounddevice numpy
python wake.py   # say "hey jarvis"
```

The first run asks for microphone access for your terminal.

## Raspberry Pi

```bash
sudo apt install -y libportaudio2
python3 -m venv .venv && source .venv/bin/activate
# On Python 3.12+, plain `pip install openwakeword` fails: it pulls in
# tflite-runtime, which only ships wheels up to 3.11. We use ONNX, so skip it.
pip install --no-deps openwakeword
pip install onnxruntime scipy scikit-learn tqdm requests numpy sounddevice
python wake.py
```

If opening the mic at 16 kHz fails, run `python -m sounddevice` to check the speakerphone is listed and what it supports.

## Custom "Hey Bart"

Train a model with openWakeWord's Colab notebook (about an hour), copy the `.onnx` here, and run:

```bash
python wake.py --model hey_bart.onnx
```
