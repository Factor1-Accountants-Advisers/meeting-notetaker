"""HTTP integration tests for the explicitly synthetic, local-only FD97 harness."""
import base64
from datetime import datetime, timedelta, timezone
import io
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import wave

REPO = Path(__file__).resolve().parents[1]
HARNESS = REPO / "scripts/fd97-processing-backend.py"


def audio_fixture():
    """Generated tone, NOT a meeting recording; exercise real audio preparation."""
    stream = io.BytesIO()
    with wave.open(stream, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"".join(struct.pack("<h", int(4000 * math.sin(i * 0.17))) for i in range(32000)))
    return base64.b64encode(stream.getvalue()).decode("ascii")


class ProcessingIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix="fd97-processing-", dir=os.environ["TMPDIR"]))
        (cls.root / "FD97_PROCESSING_TEST.json").write_text(json.dumps({"mode": "synthetic-local-only"}))
        cls.log = (cls.root / "server.log").open("w", encoding="utf-8")
        cls.addClassCleanup(cls.shutdown)
        cls.launch()

    @classmethod
    def launch(cls):
        (cls.root / "ready.json").unlink(missing_ok=True)
        env = dict(os.environ, PYTHONPATH=str(REPO / "backend"), MN_OPENAI_API_KEY="must-not-be-used", MN_PYANNOTE_API_KEY="must-not-be-used", MN_STORAGE_API_URL="https://must-not-be-used.invalid")
        cls.process = subprocess.Popen([sys.executable, str(HARNESS), "--workspace", str(cls.root)], env=env, stdout=cls.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            ready = cls.root / "ready.json"
            if ready.exists():
                cls.base = "http://127.0.0.1:" + str(json.loads(ready.read_text())["port"])
                return
            if cls.process.poll() is not None:
                cls.log.flush()
                raise AssertionError((cls.root / "server.log").read_text())
            time.sleep(0.1)
        raise AssertionError("Harness did not become ready; see " + str(cls.root))

    @classmethod
    def shutdown(cls):
        if cls.process.poll() is None:
            cls.process.terminate()
            cls.process.wait(timeout=15)
        cls.log.close()
        print("Verified local test artifacts: " + str(cls.root))

    def request(self, method, path, body=None, expected=200):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json", "X-MN-User": "Recorder", "X-MN-User-Email": "recorder@factor1.com.au", "X-MN-Graph-Token": "synthetic-test-token"})
        try:
            with urllib.request.urlopen(req, timeout=15) as response:
                code, payload = response.status, json.load(response)
        except urllib.error.HTTPError as error:
            code, payload = error.code, json.load(error)
        self.assertEqual(code, expected, payload)
        return payload

    def create_and_process(self, ended=False, title="SYNTHETIC FD97 integration"):
        now = datetime.now(timezone.utc)
        title += " " + str(time.monotonic_ns())
        metadata = {"title": title, "attendees": [], "meeting_id": title + str(time.monotonic_ns()), "prompted_call": {"nonce": str(time.monotonic_ns()), "observed_start_utc": (now - timedelta(minutes=2)).isoformat()}}
        meeting = self.request("POST", "/api/v1/meetings", {"title": title, "source": "online", "graph_metadata": metadata}, expected=201)
        mid = meeting["id"]
        if ended:
            self.request("POST", f"/api/v1/meetings/{mid}/call-observation", {"ended_at_utc": now.isoformat()})
        tone = audio_fixture()
        self.request("POST", f"/api/v1/meetings/{mid}/audio", {"audio_b64": tone, "mime_type": "audio/wav", "system_audio_b64": tone, "system_mime_type": "audio/wav", "duration_seconds": 2, "graph_metadata": metadata})
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            meeting = self.request("GET", f"/api/v1/meetings/{mid}")
            if meeting["pipeline_status"] in ("ready", "failed"):
                break
            time.sleep(0.1)
        self.assertEqual(meeting["pipeline_status"], "ready", meeting)
        self.assertGreater(meeting["unknown_speaker_count"], 0)
        for suffix in (".webm", ".mic.webm", ".system.webm"):
            file = self.root / "audio" / (mid + suffix)
            self.assertTrue(file.exists(), str(file))
            self.assertGreater(file.stat().st_size, 1000)
        return mid, meeting

    def email(self, mid):
        return self.request("POST", f"/api/v1/meetings/{mid}/email", {"recorder_email": "recorder@factor1.com.au"})

    def events(self, mid):
        return [e for e in self.request("GET", "/__fd97_test__/events") if e.get("meeting_id") == mid or mid in e.get("subject", "")]

    def test_processing_without_hangup_is_recorder_only(self):
        mid, meeting = self.create_and_process()
        self.assertIsNone(meeting["graph_metadata"]["prompted_call"].get("observed_end_utc"))
        self.request("POST", f"/api/v1/meetings/{mid}/call-participants/resolve", {}, expected=409)
        first = self.email(mid)
        second = self.email(mid)
        self.assertEqual(first["recipients"], ["recorder@factor1.com.au"])
        self.assertEqual(second["sent_now"], [])
        events = self.request("GET", "/__fd97_test__/events")
        sends = [e for e in events if e["kind"] == "email" and e["subject"].endswith(meeting["title"])]
        self.assertEqual(len(sends), 1)
        self.assertEqual(sends[0]["recipients"], ["recorder@factor1.com.au"])

    def test_pending_lookup_does_not_block_processing_or_delivery(self):
        mid, _ = self.create_and_process(ended=True)
        resolved = self.request("POST", f"/api/v1/meetings/{mid}/call-participants/resolve", {})
        self.assertEqual(resolved["call_lookup_status"], "pending")
        self.assertEqual(self.email(mid)["recipients"], ["recorder@factor1.com.au"])
        self.assertEqual(self.email(mid)["sent_now"], [])

    def test_external_network_and_mutations_fail_closed(self):
        status = self.request("GET", "/__fd97_test__/safety")
        self.assertEqual(status["mode"], "synthetic-local-only")
        self.assertTrue(status["network_blocked"])
        self.assertTrue(status["credential_settings_empty"])
        self.request("POST", "/api/v1/people/me", {"name": "Unapproved", "email": "unknown@factor1.com.au"}, expected=403)

    def test_local_artifacts_are_labelled_and_sharepoint_is_local(self):
        mid, _ = self.create_and_process(ended=True)
        saved = self.request("POST", f"/api/v1/meetings/{mid}/sharepoint", {})
        self.assertEqual(saved["sharepoint_status"], "saved")
        self.assertTrue(saved["sharepoint_web_url"].startswith("file:"))
        exports = self.root / "test-blob" / (mid + ".json")
        self.assertTrue(exports.exists())
        self.assertIn("SYNTHETIC TEST SUMMARY", exports.read_text())
        files = list((self.root / "test-sharepoint" / mid).glob("*.md"))
        self.assertEqual(len(files), 2)
        self.assertTrue(any("SYNTHETIC TEST FIXTURE" in file.read_text(encoding="utf-8") for file in files))
        for suffix in (".webm", ".mic.webm", ".system.webm"):
            self.assertEqual((self.root / "test-blob" / (mid + suffix)).read_bytes(), (self.root / "audio" / (mid + suffix)).read_bytes())

    def test_restart_preserves_pending_lookup_and_sent_delivery(self):
        mid, _ = self.create_and_process(ended=True)
        pending = self.request("POST", f"/api/v1/meetings/{mid}/call-participants/resolve", {})
        self.email(mid)
        before = self.request("GET", "/__fd97_test__/events")
        cls = type(self)
        cls.process.terminate()
        cls.process.wait(timeout=15)
        cls.launch()
        restored = self.request("GET", f"/api/v1/meetings/{mid}")
        self.assertEqual(restored["pipeline_status"], "ready")
        self.assertEqual(restored["delivery_status"], "emailed")
        self.assertEqual(restored["call_lookup_next_retry_at"], pending["call_lookup_next_retry_at"])
        self.assertEqual(self.email(mid)["sent_now"], [])
        self.request("POST", f"/api/v1/meetings/{mid}/call-participants/resolve", {})
        self.assertEqual(self.request("GET", "/__fd97_test__/events"), before)

    def test_recipient_override_is_rejected_without_send(self):
        mid, meeting = self.create_and_process()
        self.request("POST", f"/api/v1/meetings/{mid}/email", {"recorder_email": "other@factor1.com.au"}, expected=502)
        sends = [event for event in self.request("GET", "/__fd97_test__/events") if event["kind"] == "email" and event["subject"].endswith(meeting["title"])]
        self.assertEqual(sends, [])
        self.assertEqual(self.email(mid)["recipients"], ["recorder@factor1.com.au"])

    def test_launcher_rejects_unmarked_workspace(self):
        with tempfile.TemporaryDirectory(prefix="fd97-processing-", dir=os.environ["TMPDIR"]) as root:
            env = dict(os.environ, PYTHONPATH=str(REPO / "backend"))
            result = subprocess.run([sys.executable, str(HARNESS), "--workspace", root], env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("marker", result.stderr.lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
