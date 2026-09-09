from pydantic_settings import BaseSettings, SettingsConfigDict


class McpSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", ".env.local"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    sprintable_api_url: str = ""
    agent_api_key: str = ""
    # story #3722(Trust·PR2) — 이 프로세스가 실행 중인 agent run의 id(런타임이 프로세스 시작 시
    # env로 주입, fleet wake 페이로드→env 관례). MCP 요청마다 X-Sprintable-Run-Id 헤더로 실어
    # BE 귀속 축 ⓐ(헤더 우선)를 태운다. 미설정(로컬 개발·run 문맥 밖)이면 헤더 미전송 → BE가
    # ⓑ'/ⓑ/ⓒ로 자체 상관(무회귀).
    sprintable_run_id: str = ""
    sse_seen_ids_max_size: int = 10000
    sse_seen_ids_ttl_seconds: int = 3600
    # E-MCP-HTTP S1: transport 선택(기본 stdio=로컬 에이전트 무회귀·http=외부/Poke Streamable HTTP).
    mcp_transport: str = "stdio"            # "stdio" | "http"
    mcp_http_host: str = "0.0.0.0"          # http 모드 bind host
    mcp_http_port: int = 8080               # http 모드 bind port(Cloud Run $PORT 주입 가능)
    # per-key scope 캐시 bound(멀티테넌트 多키 무한증식 방지·SeenIdsCache 패턴).
    mcp_scope_cache_max_size: int = 1000
    mcp_scope_cache_ttl_seconds: int = 300
    # E-MCP-HTTP S2: DNS-rebinding 보호 호스트 화이트리스트(comma·env MCP_ALLOWED_HOSTS). FastMCP 는
    # host=localhost 류면 자동 보호 ON(allowed_hosts=localhost) → Cloud Run host(*.run.app) 거부 421.
    # 비우면(기본) **보호 OFF**(공개 호스팅 MCP=per-request bearer + Cloud Run TLS 가 실보안·브라우저
    # 로컬공격 모델 비해당). prod 승격 시 커스텀 도메인 정밀 화이트리스트(exact·서브도메인 와일드카드 X).
    mcp_allowed_hosts: str = ""


settings = McpSettings()
