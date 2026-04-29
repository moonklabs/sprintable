from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Database
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:54322/postgres"

    # Supabase / JWT
    supabase_jwt_secret: str = ""
    supabase_url: str = ""

    # App
    app_env: str = "development"
    debug: bool = True

    # EE / SaaS gating
    license_consent: str = ""

    @property
    def is_ee_enabled(self) -> bool:
        return self.license_consent.lower() == "agreed"


settings = Settings()
