"""Opt-in SYNTHETIC processing relay; never a live-provider or delivery server.

Unlike fd97-isolated-backend.py this exercises the real processing state machine.
All provider outputs are explicit fixtures. Run only in a marked scratch workspace.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import threading
import urllib.request


def validate_workspace(value):
    root = Path(value).resolve()
    scratch = Path(os.environ["TMPDIR"]).resolve()
    if root.parent != scratch or not root.name.startswith("fd97-processing-"):
        raise RuntimeError("Processing workspace must be a named direct child of TMPDIR")
    marker = root / "FD97_PROCESSING_TEST.json"
    if not marker.is_file() or json.loads(marker.read_text()).get("mode") != "synthetic-local-only":
        raise RuntimeError("Missing synthetic processing test marker")
    # Never follow existing data symlinks out of the marked test workspace.
    if any(path.is_symlink() for path in root.rglob("*")):
        raise RuntimeError("Processing workspace must not contain symlinks")
    return root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    args = parser.parse_args()
    root = validate_workspace(args.workspace)
    # Ignore ALL inherited MN_* settings (including provider keys) and .env.
    for name in list(os.environ):
        if name.startswith("MN_"):
            del os.environ[name]
    os.environ["MN_DATA_DIR"] = str(root)
    from app import config
    settings = config.Settings(_env_file=None, data_dir=str(root), sharepoint_drive_id="", storage_api_enabled=False, delivery_recipients="ask", app_version="FD97-SYNTHETIC-TEST")
    config.get_settings = lambda: settings

    # Windows creates a loopback socketpair for its event-loop wake-up pipe.
    # Construct that internal pipe before closing the outbound network boundary.
    import asyncio
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    blocked = {"count": 0}
    def deny_network(*args, **kwargs):
        blocked["count"] += 1
        raise OSError("FD97 synthetic processing: all outbound network is disabled")
    # Block HTTPS libraries and raw sockets, not only the currently used urllib.
    urllib.request.urlopen = deny_network
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    socket.socket.sendto = deny_network
    async def deny_async_network(*args, **kwargs):
        deny_network()
    # Proactor ConnectEx can bypass socket.connect on Windows.
    loop.create_connection = deny_async_network
    loop.create_datagram_endpoint = deny_async_network
    loop.sock_connect = deny_async_network

    from app import store
    from app.main import app
    from app.routers import meetings
    from app.schemas import TranscriptSegment, StructuredMeetingOutput, CallRecordResolveResponse
    from app.services import pipeline
    from app.services.meeting_voiceprints import MeetingVoiceprintResolution
    from app.services.speaker_matching import UnknownOnlySpeakerMatcher
    from app.services.sharepoint import SharePointUploadResult

    event_lock = threading.Lock()
    events_path = root / "provider-events.jsonl"
    def record(kind, **values):
        event = {"kind": kind, "synthetic": True, **values}
        with event_lock:
            with events_path.open("a", encoding="utf-8") as file:
                file.write(json.dumps(event) + "\n")

    class SyntheticSpeech:
        async def transcribe_diarized(self, audio_path, meeting):
            if not audio_path.is_file() or audio_path.stat().st_size < 1000:
                raise RuntimeError("Synthetic provider requires a prepared local audio file")
            record("transcription", meeting_id=str(meeting.id), input_bytes=audio_path.stat().st_size)
            return [TranscriptSegment(speaker="SPEAKER_00", speaker_known=False, text="SYNTHETIC TEST FIXTURE — not a transcription of the uploaded audio.", start_ms=0, end_ms=2000)]

    class SyntheticSummary:
        async def generate(self, segments, **kwargs):
            return StructuredMeetingOutput(schema_version="1.0", summary="SYNTHETIC TEST SUMMARY — not real meeting notes.", key_points=[], decisions=[], action_items=[], unresolved_questions=[], next_meeting=[], follow_ups=[], quality_flags=["synthetic_test_fixture"], source_chunks=[1])

    class LocalEmail:
        async def send_meeting_notes(self, recipients, subject, body, **kwargs):
            if recipients != ["recorder@factor1.com.au"]:
                raise RuntimeError("Synthetic recorder-only delivery boundary rejected recipients")
            record("email", recipients=recipients, subject=subject, body=body)

    class LocalSharePoint:
        async def save_transcript(self, *, meeting, filename, content, **kwargs):
            target = root / "test-sharepoint" / str(meeting.id) / Path(filename).name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            record("sharepoint", meeting_id=str(meeting.id), file=str(target))
            return SharePointUploadResult(web_url=target.as_uri(), item_id=str(meeting.id))
        async def grant_view(self, *, recipients, **kwargs):
            if recipients:
                raise RuntimeError("Participant sharing disabled in synthetic processing harness")
            return []

    class PendingParticipants:
        def resolve_call_records(self, meeting_id, *args):
            record("participant_lookup", meeting_id=str(meeting_id))
            return CallRecordResolveResponse(status="pending", participants=[], retry_after_seconds=60)

    async def local_blob(meeting_id, **kwargs):
        target = root / "test-blob" / (str(meeting_id) + ".json")
        target.parent.mkdir(exist_ok=True)
        target.write_text(json.dumps(store.MEETING_EXPORTS[meeting_id], default=str), encoding="utf-8")
        import shutil
        for suffix in (".webm", ".mic.webm", ".system.webm"):
            source = root / "audio" / (str(meeting_id) + suffix)
            if source.exists():
                shutil.copyfile(source, target.parent / source.name)
        record("blob", meeting_id=str(meeting_id), file=str(target))

    pipeline.STAGE_DELAY_S = 0
    pipeline.get_speech_provider = lambda: SyntheticSpeech()
    pipeline.get_speaker_matcher = lambda: UnknownOnlySpeakerMatcher()
    pipeline.resolve_meeting_voiceprints = lambda *a, **k: MeetingVoiceprintResolution(records=[], degraded=False, request_count=0)
    pipeline.get_llm_provider = lambda: SyntheticSummary()
    pipeline.get_company_context = lambda *a, **k: None
    pipeline.deliver_meeting_to_blob = local_blob
    meetings.get_email_provider = lambda *a: LocalEmail()
    meetings.get_sharepoint_provider = lambda *a: LocalSharePoint()
    meetings.get_storage_api_client = lambda: PendingParticipants()

    from fastapi.responses import JSONResponse
    import re
    allowed_meeting_post = re.compile(r"/api/v1/meetings/[0-9a-f-]{36}/(?:audio|retry|email|sharepoint|call-observation|call-participants/resolve)$")
    @app.middleware("http")
    async def harness_boundary(request, call_next):
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            if request.headers.get("X-MN-User") != "Recorder" or request.headers.get("X-MN-User-Email") != "recorder@factor1.com.au":
                return JSONResponse(status_code=403, content={"detail": "Synthetic tester identity required"})
            if request.method != "POST" or not (request.url.path == "/api/v1/meetings" or allowed_meeting_post.fullmatch(request.url.path)):
                return JSONResponse(status_code=403, content={"detail": "Route disabled in synthetic processing harness"})
        response = await call_next(request)
        response.headers["X-FD97-Test-Mode"] = "synthetic-local-only"
        return response

    @app.get("/__fd97_test__/events")
    async def events():
        with event_lock:
            return [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines()] if events_path.exists() else []

    @app.get("/__fd97_test__/safety")
    async def safety():
        probes = []
        for probe in (lambda: urllib.request.urlopen("https://example.invalid"), lambda: socket.create_connection(("127.0.0.1", 9), timeout=0.1)):
            try:
                probe()
                probes.append(False)
            except OSError:
                probes.append(True)
        for probe in (loop.create_connection(None, "127.0.0.1", 9), loop.create_datagram_endpoint(None, remote_addr=("127.0.0.1", 9))):
            try:
                await probe
                probes.append(False)
            except OSError:
                probes.append(True)
        return {"mode": "synthetic-local-only", "network_blocked": all(probes), "blocked_attempts": blocked["count"], "credential_settings_empty": not any((settings.openai_api_key, settings.pyannote_api_key, settings.storage_api_url, settings.sharepoint_drive_id)), "workspace": str(root)}

    import uvicorn
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
    async def publish_ready():
        import asyncio
        while not server.started:
            await asyncio.sleep(0.02)
        (root / "ready.json").write_text(json.dumps({"port": listener.getsockname()[1], "mode": "synthetic-local-only"}))
    async def run():
        import asyncio
        ready = asyncio.create_task(publish_ready())
        try:
            await server.serve(sockets=[listener])
        finally:
            ready.cancel()
            (root / "ready.json").unlink(missing_ok=True)
    try:
        loop.run_until_complete(run())
    finally:
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.run_until_complete(loop.shutdown_default_executor())
        loop.close()


if __name__ == "__main__":
    main()
