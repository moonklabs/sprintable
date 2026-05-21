from pydantic_settings import BaseSettings, SettingsConfigDict


class McpSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    sprintable_api_url: str = ""
    agent_api_key: str = ""
    fakechat_port: int = 8787
    sse_seen_ids_max_size: int = 10000
    sse_seen_ids_ttl_seconds: int = 3600
    has_webhook: bool = False  # True: fakechat relay 전체 스킵, Discord 웹훅으로만 수신


settings = McpSettings()
