# sprintable-mcp

BYO 에이전트용 Sprintable MCP 서버. 에이전트 런타임을 Sprintable API에 stdio로 연결한다.
**레포 clone 불필요** — `uvx` 한 줄로 구동.

## Quick start

```bash
export SPRINTABLE_API_URL=https://app.sprintable.ai     # 또는 dev 백엔드 URL
export AGENT_API_KEY=sk_live_...                         # 에이전트 API 키
uvx sprintable-mcp
```

설치형:

```bash
pip install sprintable-mcp
sprintable-mcp        # 엔트리포인트
# 또는
python -m sprintable_mcp
```

## 동작

- 부팅 시 `/api/v2/auth/me`로 인증 컨텍스트를 잡고, `/api/v2/mcp/manifest`로 **이 키의 허용
  toolset**을 받아 **허용된 도구만 노출**한다(E-MCP S3). 호출 시에도 허용 밖 도구는 차단(E-MCP S2).
- 매니페스트를 못 받으면 레거시 비파괴셋으로 안전 degrade(파괴적 도구 숨김). crash 없음.

## 의존성

backend(app/*) 비의존 — `mcp` / `httpx` / `pydantic` / `pydantic-settings`만 필요(E-MCP S4 import 디탱글).

## 필수 환경변수

| 변수 | 설명 |
|------|------|
| `SPRINTABLE_API_URL` | Sprintable 백엔드 URL |
| `AGENT_API_KEY` | 에이전트 API 키(`sk_live_...`) |
