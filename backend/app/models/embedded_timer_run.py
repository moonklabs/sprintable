"""story 4826 — when each in-app timer job last ran (`services/embedded_timers.py`).

One row per job (`job_name` = its cron route). The app's own backend keeps the scheduled work the cloud scheduler does for a hosted deployment: a job whose interval
has passed while the app was closed runs once right after start, however many times it was missed — this row is how a restart knows the time.
Time is the database's (`now()`), never a process's own clock.
"""
from datetime import datetime

from sqlalchemy import DateTime, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class EmbeddedTimerRun(Base):
    __tablename__ = "embedded_timer_runs"

    job_name: Mapped[str] = mapped_column(Text, primary_key=True)
    last_run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_status: Mapped[int | None] = mapped_column(Integer, nullable=True)  # the HTTP status the job answered (None: it could not be called)
    last_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)  # how long that lap took
