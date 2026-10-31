"""Run on the Pi: cd pi && venv/bin/python -m unittest -v test_wake."""
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
import wave

import numpy as np
import requests

import wake


class RecordingTests(unittest.TestCase):
    def test_keeps_onset_and_ends_after_silence(self):
        pre_roll = np.full(9600, 0.07, dtype=np.float32)
        utterance = wake.Utterance(wake.Config(), [pre_roll])
        speech = np.full(1600, 0.1, dtype=np.float32)
        quiet = np.zeros(1600, dtype=np.float32)
        for _ in range(8):
            self.assertFalse(utterance.add(speech))
        for _ in range(14):
            self.assertFalse(utterance.add(quiet))
        self.assertTrue(utterance.add(quiet))
        self.assertEqual(utterance.reason, "silence")
        np.testing.assert_array_equal(utterance.audio()[:9600], pre_roll)
        with tempfile.TemporaryDirectory() as directory:
            path = wake.save_wav(utterance.audio(), Path(directory))
            with wave.open(str(path)) as saved:
                self.assertEqual((saved.getframerate(), saved.getnchannels(), saved.getsampwidth()),
                                 (16000, 1, 2))
                self.assertEqual(saved.getnframes(), 46400)

    def test_noise_cannot_record_past_fifteen_seconds(self):
        utterance = wake.Utterance(wake.Config(), [np.ones(9500, dtype=np.float32)])
        for _ in range(200):
            if utterance.add(np.ones(1600, dtype=np.float32)):
                break
        self.assertEqual(utterance.reason, "15s cap")
        self.assertEqual(len(utterance.audio()), 15 * wake.RATE)

    def test_chime_alone_does_not_count_as_a_question(self):
        utterance = wake.Utterance(wake.Config(), [])
        for _ in range(3):
            self.assertFalse(utterance.add(np.ones(1600, dtype=np.float32)))
        for _ in range(46):
            self.assertFalse(utterance.add(np.zeros(1600, dtype=np.float32)))
        self.assertTrue(utterance.add(np.zeros(1600, dtype=np.float32)))
        self.assertEqual(utterance.reason, "no speech timeout")


class TurnTests(unittest.TestCase):
    def setUp(self):
        mixer = patch.object(wake, "prepare_speaker")
        mixer.start()
        self.addCleanup(mixer.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = wake.save_wav(np.zeros(1600), Path(self.directory.name))
        self.cfg = replace(wake.Config(), turn_url="http://localhost/turn")

    @patch.object(wake, "play_mp3")
    @patch.object(wake.time, "sleep")
    def test_retry_reopens_wav_and_keeps_session_and_request_id(self, sleep, playback):
        response = Mock(status_code=200, headers={"Content-Type": "audio/mpeg"})
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.iter_content.return_value = [b"mp3-reply"]
        requests_seen = []
        def post(url, **kwargs):
            requests_seen.append((kwargs["files"]["audio"][1].read(),
                                  kwargs["data"], kwargs["headers"]))
            if len(requests_seen) == 1:
                raise requests.ConnectionError("offline")
            return response
        http = Mock(post=post)
        wake.send_turn(self.cfg, self.path, "same-session", "JV801", http)
        self.assertEqual(len(requests_seen), 2)
        self.assertEqual(requests_seen[0], requests_seen[1])
        self.assertEqual(requests_seen[1][0], self.path.read_bytes())
        self.assertEqual(requests_seen[1][1], {"session_id": "same-session"})
        sleep.assert_called_once_with(1)
        playback.assert_called_once_with(b"mp3-reply", "JV801")

    @patch.object(wake.time, "sleep")
    def test_offline_returns_with_wav_intact(self, sleep):
        http = Mock()
        http.post.side_effect = requests.Timeout()
        original = self.path.read_bytes()
        wake.send_turn(self.cfg, self.path, "session", "JV801", http)
        self.assertEqual(http.post.call_count, 3)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [1, 2])

    @patch.object(wake, "play_mp3")
    def test_invalid_reply_does_not_play_or_crash(self, playback):
        response = Mock(status_code=200, headers={"Content-Type": "application/json"})
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        http = Mock()
        http.post.return_value = response
        wake.send_turn(self.cfg, self.path, "session", "JV801", http)
        playback.assert_not_called()
        self.assertTrue(self.path.exists())

    @patch.object(wake, "play_mp3")
    @patch.object(wake.time, "sleep")
    def test_real_http_multipart_and_503_recovery(self, sleep, playback):
        received = []
        class Endpoint(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                received.append((dict(self.headers), body))
                self.send_response(503 if len(received) == 1 else 200)
                self.send_header("Content-Type", "audio/mpeg")
                self.end_headers()
                self.wfile.write(b"test-mp3")
            def log_message(self, *_):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Endpoint)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            cfg = replace(self.cfg, turn_url=f"http://127.0.0.1:{server.server_port}/turn")
            with requests.Session() as http:
                wake.send_turn(cfg, self.path, "wire-session", "JV801", http)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()
        self.assertEqual(len(received), 2)
        for headers, body in received:
            self.assertIn("multipart/form-data", headers["Content-Type"])
            self.assertIn(b'name="audio"', body)
            self.assertIn(b'name="session_id"', body)
            self.assertIn(b"wire-session", body)
            self.assertIn(self.path.read_bytes(), body)
        self.assertEqual(received[0][0]["Idempotency-Key"], received[1][0]["Idempotency-Key"])
        playback.assert_called_once_with(b"test-mp3", "JV801")


if __name__ == "__main__":
    unittest.main()
