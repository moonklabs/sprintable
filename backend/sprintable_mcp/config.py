from pydantic_settings import BaseSettings, SettingsConfigDict


class McpSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    sprintable_api_url: str = ""
    agent_api_key: str = ""
    sse_seen_ids_max_size: int = 10000
    sse_seen_ids_ttl_seconds: int = 3600
    # E-MCP-HTTP S1: transport 선택(기본 stdio=로컬 에이전트 무회귀·http=외부/Poke Streamable HTTP).
    mcp_transport: str = "stdio"            # "stdio" | "http"
    mcp_http_host: str = "0.0.0.0"          # http 모드 bind host
    mcp_http_port: int = 8080               # http 모드 bind port(Cloud Run $PORT 주입 가능)
    # per-key scope 캐시 bound(멀티테넌트 多키 무한증식 방지·SeenIdsCache 패턴).
    mcp_scope_cache_max_size: int = 1000
    mcp_scope_cache_ttl_seconds: int = 300


settings = McpSettings()
