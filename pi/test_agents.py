"""Hold a conversation through the same realtime session wake_word.py opens, with the agents attached.

    python test_agents.py "I'm starting a new book" "yes"                 # one turn per argument
    python test_agents.py "share what I boxed with David" "take the photo"
    python test_agents.py --wav recordings/20261030-181536-891889.wav     # a sentence you recorded
    BART_TEST_IMAGE=cover.jpg python test_agents.py "add a new book"      # photo stand-in on a laptop

Prints what you said, the reply transcripts and every agent call. No mic, wake word or speaker.
Each turn waits for the previous one to finish, including any tool calls and the follow-up reply.
"""
import argparse
import base64
import wave
from pathlib import Path

import numpy as np
from dotenv import load_dotenv
from openai import OpenAI

import agents

REALTIME_RATE = 24000
# Same as wake_word.py, so the test behaves like the device
INSTRUCTIONS = (
    "You are Bart, a reading companion. The user is reading a physical book and talking to you "
    "through a small speaker. Answer directly in one to three short spoken sentences. "
    "Don't announce that you're thinking."
)

parser = argparse.ArgumentParser()
parser.add_argument("turns", nargs="*", help="typed messages, one per turn")
parser.add_argument("--wav", action="append", default=[], help="16 kHz mono WAV, like the ones in recordings/; repeatable")
parser.add_argument("--model", default="gpt-realtime-2.1-mini")
args = parser.parse_args()
if not (args.turns or args.wav):
    parser.error("give a message or --wav")

load_dotenv(Path(__file__).parent / ".env")
tools, tool_instructions = agents.start()


def send_wav(conn, path):
    with wave.open(path) as w:
        rate, x = w.getframerate(), np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
    n = int(len(x) * REALTIME_RATE / rate)
    pcm = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.int16)
    conn.input_audio_buffer.append(audio=base64.b64encode(pcm.tobytes()).decode())
    conn.input_audio_buffer.commit()


with OpenAI().realtime.connect(model=args.model) as conn:
    conn.session.update(session={
        "type": "realtime",
        "instructions": INSTRUCTIONS + tool_instructions,
        "tools": tools,
        "output_modalities": ["audio"],
        "audio": {
            "input": {"format": {"type": "audio/pcm", "rate": REALTIME_RATE}, "turn_detection": None,
                      "transcription": {"model": "gpt-4o-mini-transcribe"}},
            "output": {"format": {"type": "audio/pcm", "rate": REALTIME_RATE}, "voice": "marin"},
        },
    })
    for turn in [("wav", w) for w in args.wav] + [("text", t) for t in args.turns]:
        agents.deliver(conn)
        if turn[0] == "wav":
            send_wav(conn, turn[1])
        else:
            print(f"  you: {turn[1]}")
            conn.conversation.item.create(item={"type": "message", "role": "user", "content": [{"type": "input_text", "text": turn[1]}]})
        conn.response.create()

        for event in conn:
            if event.type == "conversation.item.input_audio_transcription.completed":
                print(f"  you: {event.transcript.strip()}")
            elif event.type == "response.output_audio_transcript.done":
                print(f"  bart: {event.transcript.strip()}")
            elif event.type == "error":
                print(f"  openai error: {event.error.message}")
                break
            elif event.type == "response.done":
                if agents.handle(conn, event.response, on_captured=lambda: print("  bart: Captured.")):
                    continue
                break

agents.wait_for_research()  # red marks are researched in the background
agents.stop()
