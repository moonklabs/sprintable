from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.routers import analytics, audit_logs, current_project, dashboard, docs, epics, health, invitations, me, meetings, members, memos, notifications, org_members, organizations, project_settings, projects, retros, rewards, sprints, standups, stories, tasks, team_members

app = FastAPI(
    title="Sprintable API v2",
    description="FastAPI backend — Phase B migration layer",
    version="0.1.0",
    docs_url="/api/v2/_swagger" if settings.debug else None,
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3108", "https://app.sprintable.ai"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(sprints.router)
app.include_router(epics.router)
app.include_router(tasks.router)
app.include_router(docs.router)
app.include_router(meetings.router)
app.include_router(stories.router)
app.include_router(projects.router)
app.include_router(team_members.router)
app.include_router(org_members.router)
app.include_router(standups.router)
app.include_router(retros.router)
app.include_router(memos.router)
app.include_router(notifications.router)
app.include_router(analytics.router)
app.include_router(invitations.router)
app.include_router(rewards.router)
app.include_router(audit_logs.router)
app.include_router(dashboard.router)
app.include_router(current_project.router)
app.include_router(members.router)
app.include_router(organizations.router)
app.include_router(me.router)
app.include_router(project_settings.router)

if settings.is_ee_enabled:
    from ee.routers import billing  # type: ignore[import]
    app.include_router(billing.router, prefix="/api/v2/billing")
