"""Celery application configuration.

Configures Celery for background task processing with Redis as broker.
"""
from celery import Celery

from app.core.config import settings

# Create Celery app
celery_app = Celery(
    "meeting_notetaker",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.services.pipeline"]
)

# Celery configuration
celery_app.conf.update(
    # Task settings
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,

    # Task execution settings
    task_acks_late=True,  # Acknowledge after task completion
    task_reject_on_worker_lost=True,  # Requeue if worker dies
    task_time_limit=3600,  # 1 hour max per task
    task_soft_time_limit=3300,  # Soft limit 55 minutes

    # Worker settings
    worker_prefetch_multiplier=1,  # Process one task at a time
    worker_concurrency=2,  # Number of concurrent workers

    # Result backend settings
    result_expires=86400,  # Results expire after 24 hours

    # Task routing (for future scaling)
    task_routes={
        "app.services.pipeline.*": {"queue": "pipeline"},
    },

    # Default queue
    task_default_queue="default",
)


# Optional: Configure task priority
celery_app.conf.broker_transport_options = {
    "priority_steps": list(range(10)),
    "sep": ":",
    "queue_order_strategy": "priority",
}
