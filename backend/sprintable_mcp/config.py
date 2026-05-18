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


settings = McpSettings()
