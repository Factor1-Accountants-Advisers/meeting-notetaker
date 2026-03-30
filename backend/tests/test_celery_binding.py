from app.celery_app import celery_app
from app.services.pipeline import (
    cleanup_temp_files,
    diarize_meeting,
    process_meeting,
    summarise_meeting,
    transcribe_meeting,
)


def test_pipeline_tasks_bind_to_configured_celery_app():
    expected_broker = celery_app.conf.broker_url

    assert process_meeting.app is celery_app
    assert transcribe_meeting.app is celery_app
    assert diarize_meeting.app is celery_app
    assert summarise_meeting.app is celery_app
    assert cleanup_temp_files.app is celery_app

    assert process_meeting.app.connection().as_uri() == expected_broker
