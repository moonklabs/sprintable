from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Database
    # Cloud SQL Auth Proxy 연결 예시:
    #   postgresql+asyncpg://sprintable:PASSWORD@127.0.0.1:5433/sprintable
    # Cloud SQL Unix socket 연결 예시 (Cloud Run 등):
    #   postgresql+asyncpg://sprintable:PASSWORD@/sprintable?host=/cloudsql/sprintable:asia-northeast3:sprintable-dev
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:54322/postgres"

    # Cloud SQL (D-S1: Phase D GCP 인프라)
    cloud_sql_instance_dev: str = "sprintable-494803:asia-northeast3:sprintable-dev"
    cloud_sql_instance_prod: str = "sprintable-494803:asia-northeast3:sprintable-prod"

    # JWT
    jwt_secret: str = ""

    # Supabase (Phase C 과도기 — DB 쿼리 라우트 125개 전환 완료 전까지 유지)
    supabase_jwt_secret: str = ""
    supabase_url: str = ""

    # CORS (쉼표 구분 origins, Cloud Run 환경변수 CORS_ORIGINS로 주입)
    cors_origins: str = "http://localhost:3000,http://localhost:3108,https://app.sprintable.ai"

    # App
    app_env: str = "development"
    debug: bool = True

    # OAuth — Google / GitHub
    google_client_id: str = ""
    google_client_secret: str = ""
    github_client_id: str = ""
    github_client_secret: str = ""
    # Next.js 프론트엔드 URL (OAuth redirect_uri 조합용)
    app_url: str = "http://localhost:3000"

    # EE / SaaS gating
    license_consent: str = ""

    @property
    def is_ee_enabled(self) -> bool:
        return self.license_consent.lower() == "agreed"

    @property
    def effective_jwt_secret(self) -> str:
        return self.jwt_secret or self.supabase_jwt_secret


settings = Settings()
