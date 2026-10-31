"""Bart's agents in the realtime conversation: the tools offered to the model, and running the ones it calls.

The agents live in the web/ app (Vercel). wake_word.py uses three hooks:

    tools, extra = agents.start()            # conversation opens: tools + instructions for session.update
    agents.deliver(conn)                     # before each sentence: hand over finished background runs
    if agents.handle(conn, event.response):  # on response.done: run tool calls, send results back,
        continue                             # and keep streaming the model's follow-up reply
    agents.stop()                            # conversation ends: turn the camera off

The camera_on tool turns the camera on here and leaves it on across turns, so the reader can line up the
shot before saying "take the photo". It goes off when a photo tool's result says camera: "off".

Red pen marks come back as research requests. Each one runs in a background thread; when the answer is in,
Bart says it out loud on its own (agents.configure(say=...)), even between conversations, and the next
conversation turn gets it as context.

Needs BART_URL and BART_TOKEN in pi/.env; without them the conversation works as before, with no tools.
Photos come from the Pi camera, or a webcam (pip install opencv-python) on a laptop;
BART_TEST_IMAGE=path/to/photo.jpg sends a file instead.
"""
import io
import json
import os
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import vault

_agents = {}  # name -> manifest entry (needsImage, async, built)
_session_id = None
_pending = []  # (run_id, agent name) of background runs not yet handed to the model
_camera = None  # open between camera_on and a result with camera: "off"
_test_shots = 0  # photos taken so far from BART_TEST_IMAGE
_say = lambda text: print(f"  bart (unprompted): {text}")  # replaced by wake_word.py with text-to-speech
_told = []  # things Bart said unprompted, handed to the conversation by deliver()
_research = []  # background research threads


def _url():
    return os.environ.get("BART_URL", "").rstrip("/")


def _request(path, body=None, content_type=None):
    headers = {"x-bart-token": os.environ.get("BART_TOKEN", "")}
    if content_type:
        headers["content-type"] = content_type
    try:
        with urllib.request.urlopen(urllib.request.Request(_url() + path, data=body, headers=headers), timeout=120) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        # The routes answer errors as JSON too
        try:
            return json.load(e)
        except ValueError:
            return {"status": "error", "error": f"HTTP {e.code}"}


def configure(say):
    """say(text) speaks a sentence aloud; used for research answers that arrive on their own."""
    global _say
    _say = say


def start():
    """A conversation is opening: returns (tools, instructions) to add to the session. Empty when unavailable."""
    global _agents, _session_id
    _agents, _session_id = {}, str(uuid.uuid4())
    _pending.clear()
    camera_off()
    if not (_url() and os.environ.get("BART_TOKEN")):
        print("no BART_URL / BART_TOKEN in pi/.env, so no agents")
        return [], ""
    try:
        config = _request("/api/agents")
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"can't reach the agents at {_url()} ({e}), continuing without them")
        return [], ""
    if "tools" not in config:
        print(f"agents unavailable: {config.get('error', config)}")
        return [], ""
    _agents = {a["name"]: a for a in config["agents"]}
    built = [a["name"] for a in config["agents"] if a["built"]]
    print(f"agents: {len(config['tools'])} tools, built: {', '.join(built) or 'none'}")
    return config["tools"], "\n\n" + config["instructions"]


def handle(conn, response, on_countdown=None, on_captured=None):
    """If the response ended in tool calls, run them, send the results and ask for a new response. True if it did."""
    calls = [item for item in response.output or [] if item.type == "function_call"]
    if not calls:
        return False
    for call in calls:
        result = run(call.name, call.arguments, call.call_id, on_countdown, on_captured)
        detail = result.get("error") or json.dumps(result.get("result"))
        print(f"  agent: {call.name}({call.arguments}) -> {result.get('status')}: {detail}")
        if result.get("status") == "running":
            _pending.append((result["run_id"], call.name))
        if (result.get("result") or {}).get("camera") == "off":
            camera_off()
        for request in (result.get("result") or {}).get("research") or []:
            research_in_background(request)
        conn.conversation.item.create(
            item={"type": "function_call_output", "call_id": call.call_id, "output": json.dumps(result)}
        )
    conn.response.create()
    vault.sync_in_background()  # pick up any note the agents just wrote
    return True


def research_in_background(request):
    """Look up something marked in red, then say the answer unprompted. Quick: ~20 s. Thorough: also saved to notes."""
    def work():
        result = run("research", json.dumps(request))
        found = result.get("result") or {}
        print(f"  agent: research({request['depth']}: {request['topic']}) -> {result.get('status')}: {found.get('answer') or found.get('reason') or result.get('error')}")
        if found.get("answer"):
            _say(found["answer"])
            _told.append(f"You told the reader, unprompted, about \"{request['topic']}\" (marked in red): {found['answer']}")
        if found.get("saved"):
            vault.sync_in_background()

    thread = threading.Thread(target=work, daemon=True)
    _research.append(thread)
    thread.start()


def wait_for_research(timeout=150):
    """Block until background research is done (for scripts that would otherwise exit first)."""
    for thread in list(_research):
        thread.join(timeout)


def deliver(conn):
    """Add finished background runs, and anything Bart said unprompted, to the conversation for its next reply."""
    while _told:
        conn.conversation.item.create(item={"type": "message", "role": "system", "content": [{"type": "input_text", "text": _told.pop(0)}]})
    for run_id, name in list(_pending):
        try:
            run = _request(f"/api/runs/{run_id}")
        except (urllib.error.URLError, TimeoutError):
            return
        if run.get("status") in (None, "running"):
            continue
        _pending.remove((run_id, name))
        print(f"  agent: {name} finished -> {run['status']}")
        text = f"Background agent {name} finished with status {run['status']}: {json.dumps(run.get('result') or run.get('error'))}"
        conn.conversation.item.create(item={"type": "message", "role": "system", "content": [{"type": "input_text", "text": text}]})


def stop():
    """The conversation is over."""
    camera_off()


def camera_on():
    global _camera
    if os.environ.get("BART_TEST_IMAGE"):
        print("  camera on (using BART_TEST_IMAGE)")
        return True
    if not _camera:
        _camera = _open_camera()
        print("  camera on" if _camera else "  no camera found (picamera2, or a webcam via opencv-python)")
    return bool(_camera)


def camera_off():
    global _camera
    if _camera:
        _camera.close()
        _camera = None
        print("  camera off")


def run(name, arguments, call_id=None, on_countdown=None, on_captured=None):
    """POST one agent call to the server, with a photo first if the agent needs one."""
    if name == "camera_on" and not camera_on():
        return {"status": "error", "error": "The camera didn't turn on: no Pi camera or webcam found."}
    fields = {"args": arguments or "{}", "session_id": _session_id, "call_id": call_id or "", "client": "pi"}
    need = (_agents.get(name) or {}).get("needsImage")
    photo = capture(need["countdown"], on_countdown) if need else None
    if photo and on_captured:
        on_captured()  # say "Captured." now; reading the photo takes a few more seconds
    try:
        if photo:
            return _request(f"/api/agents/{name}", *_multipart(fields, photo))
        body = json.dumps({**fields, "args": json.loads(fields["args"])}).encode()
        return _request(f"/api/agents/{name}", body, "application/json")
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        return {"status": "error", "error": f"couldn't reach the agent server: {e}"}


def capture(countdown, on_countdown=None):
    """Count down (countdown 0: the reader said "take the photo"), then take a JPEG.

    on_countdown(n) is called on each second, and with 0 as the shutter fires.
    Camera: BART_TEST_IMAGE if set, else the Pi camera, else a webcam (a laptop, or USB on the Pi).
    """
    # Use the camera camera_on left on; otherwise open one just for this photo, before the countdown so
    # exposure settles meanwhile
    cam = _camera or _open_camera()
    temporary = cam is not _camera
    for n in range(countdown, 0, -1):
        print(f"  photo in {n}...")
        if on_countdown:
            on_countdown(n)
        time.sleep(1)
    if cam and temporary and not countdown:
        time.sleep(1)  # no countdown to hide the camera's warm-up behind
    print("  taking the photo")
    if on_countdown:
        on_countdown(0)
    if test_images := os.environ.get("BART_TEST_IMAGE"):
        # A comma-separated list is used in order, one per photo (the last repeats): handy for retries
        global _test_shots
        paths = test_images.split(",")
        path = paths[min(_test_shots, len(paths) - 1)]
        _test_shots += 1
        print(f"  (test photo {path})")
        return Path(path.strip()).expanduser().read_bytes()
    if not cam:
        print("  no camera found (picamera2 or a webcam via opencv-python), sending without a photo")
        return None
    try:
        return cam.take()
    finally:
        if temporary:
            cam.close()


class _PiCamera:
    def __init__(self):
        from picamera2 import Picamera2  # preinstalled on Raspberry Pi OS; use a venv with --system-site-packages

        self.cam = Picamera2()
        # Half the Camera Module 3's resolution: a page stays legible and the upload stays well under Vercel's 4.5 MB limit
        self.cam.configure(self.cam.create_still_configuration(main={"size": (2304, 1296)}))
        self.cam.start()

    def take(self):
        try:
            self.cam.autofocus_cycle()
        except Exception:
            pass  # only the Camera Module 3 has autofocus
        buf = io.BytesIO()
        self.cam.capture_file(buf, format="jpeg")
        return buf.getvalue()

    def close(self):
        self.cam.stop()
        self.cam.close()


class _Webcam:
    def __init__(self):
        import cv2

        self.cv2 = cv2
        self.cap = cv2.VideoCapture(int(os.environ.get("BART_WEBCAM", "0")))
        if not self.cap.isOpened():
            raise RuntimeError("webcam not available (on a Mac, allow camera access for your terminal)")
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)

    def take(self):
        # Webcams buffer frames and adjust exposure as they run: read for a moment, keep the last frame
        frame, until = None, time.time() + 0.5
        while time.time() < until or frame is None:
            ok, f = self.cap.read()
            if ok:
                frame = f
            elif time.time() > until + 2:
                raise RuntimeError("webcam returned no frames")
        ok, jpeg = self.cv2.imencode(".jpg", frame, [self.cv2.IMWRITE_JPEG_QUALITY, 90])
        return jpeg.tobytes()

    def close(self):
        self.cap.release()


def _open_camera():
    if os.environ.get("BART_TEST_IMAGE"):
        return None
    for camera in (_PiCamera, _Webcam):
        try:
            return camera()
        except Exception:
            continue
    return None


def _multipart(fields, photo):
    boundary = uuid.uuid4().hex
    out = io.BytesIO()
    for key, value in fields.items():
        out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="capture.jpg"\r\n'
              "Content-Type: image/jpeg\r\n\r\n".encode())
    out.write(photo)
    out.write(f"\r\n--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"
