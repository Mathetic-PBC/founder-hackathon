"""Listen on the default mic and print when the wake word is heard.

    python wake.py                          # built-in "hey jarvis" model
    python wake.py --model hey_bart.onnx    # custom model from the Colab notebook

Same script runs on a Mac and on the Pi.
"""
import argparse

import numpy as np
import openwakeword
import sounddevice as sd
from openwakeword.model import Model

SAMPLE_RATE = 16000
FRAME = 1280  # 80 ms, the chunk size openWakeWord expects

parser = argparse.ArgumentParser()
parser.add_argument("--model", default="hey_jarvis", help="built-in model name or path to a .onnx file")
parser.add_argument("--threshold", type=float, default=0.5)
args = parser.parse_args()

if not args.model.endswith(".onnx"):
    openwakeword.utils.download_models([args.model])
model = Model(wakeword_models=[args.model], inference_framework="onnx")

with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16", blocksize=FRAME) as mic:
    print(f"listening for {args.model} on {sd.query_devices(kind='input')['name']}...")
    while True:
        frame, _ = mic.read(FRAME)
        scores = model.predict(np.squeeze(frame))
        if max(scores.values()) > args.threshold:
            print("heard it", scores)
            model.reset()
