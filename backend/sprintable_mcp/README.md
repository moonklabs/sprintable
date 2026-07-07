# Sprintable MCP

BYO 에이전트용 Sprintable MCP 서버. 에이전트 런타임을 Sprintable API에 stdio로 연결한다.
**레포 clone 불필요** — `uvx` 한 줄로 구동.

## Quick start

```bash
export SPRINTABLE_API_URL=https://app.sprintable.ai     # 또는 dev 백엔드 URL
export AGENT_API_KEY=sk_live_...                         # 에이전트 API 키
uvx sprintable
```

설치형:

```bash
pip install sprintable
sprintable        # 엔트리포인트
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
| `AGENT_API_KEY` | 에이전트 API 키(`sk_live_...`). http 모드는 per-request bearer 가 실인증이라 never-hit fallback |
| `MCP_TRANSPORT` | `stdio`(기본·로컬) \| `http`(Cloud Run 호스팅) |
| `MCP_ALLOWED_HOSTS` | http 모드 DNS-rebinding 보호 호스트 화이트리스트(comma·exact). 비우면 보호 OFF(bearer+TLS 가 실보안) |

## Cloud Run 호스팅 배포

| 환경 | 스크립트 | 서비스 | MCP_ALLOWED_HOSTS |
|------|----------|--------|-------------------|
| dev  | `scripts/deploy_mcp_dev.sh`  | `sprintable-mcp-dev`  | (비움·보호 OFF) |
| prod | `scripts/deploy_mcp_prod.sh` | `sprintable-mcp-prod` | `sprintable-mcp-prod-787818285179.asia-northeast3.run.app,mcp.sprintable.ai`(exact·보호 ON·다중) |

- 동일 backend 이미지를 `python -m sprintable_mcp` command override 로 구동(별 빌드 0).
- **gcloud 배포 실행은 PO 전담**(인프라 lane). 스크립트는 PR 리뷰 대상.
- prod `AGENT_API_KEY` 는 Secret Manager 참조(`AGENT_API_KEY_SECRET=<secret-name>`)·값 노출 0. 미지정 시
  per-request-bearer placeholder 로 폴백(http 모드 실인증=per-request bearer).
- **온보딩 config**: prod 백엔드에 `MCP_PUBLIC_URL`(=`https://mcp.sprintable.ai/mcp` 깔끔 도메인) 설정 시
  온보딩 응답 `mcp_config` 가 streamable-http(`type:"http"`+Bearer)로 생성(미설정=dev localhost SSE).

### 고객 facing 깔끔 도메인(mcp.sprintable.ai)

raw Cloud Run URL 대신 고객엔 `https://mcp.sprintable.ai/mcp` 노출. **CF route/Worker proxy** 패턴(app.sprintable.ai
와 동일·Cloud Run domain-mapping 미사용·`cf-ray` 확認). additive — raw run.app origin 유지하며 깔끔 도메인 추가.
- **MCP_ALLOWED_HOSTS additive**: run.app(오리진) + `mcp.sprintable.ai`(CF 가 원본 Host 전달 시 421 방지·S2
  DNS-rebinding). `--set-env-vars` 가 comma 로 항목 구분하므로 다중 host 값은 `^##^` 커스텀 구분자로 escape.
- **PO 마무리**: ①CF zone DNS(mcp 서브도메인 → run.app origin·가능하면 origin Host=run.app override) ②게이트웨이
  재배포 또는 `gcloud run services update sprintable-mcp-prod --update-env-vars="^##^MCP_ALLOWED_HOSTS=run.app,mcp.sprintable.ai"`
  ③prod 백엔드 `MCP_PUBLIC_URL=https://mcp.sprintable.ai/mcp` `--update-env-vars`.
