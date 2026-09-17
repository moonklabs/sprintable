# 데스크톱 앱 · 로컬 에이전트 온보딩 설계

> 상태: **초안 (설계 착수)** — 결정 6건 확정, 미결 5건 남음. §9 참조.
> 작성 배경: BYOM 자격증명 연결이 최대 채택 장벽이라는 진단에서 출발했으나,
> 조사 결과 **장벽의 실체는 모델 키가 아니라 로컬 에이전트 배선**이었다(§2).

---

## 1. 개요

Sprintable을 데스크톱에서 실행되는 **채팅 중심 클라이언트**로 확장한다. 사용자가 이미 로컬에서
쓰고 있는 코딩 에이전트(Claude Code, Codex, Grok, OpenCode, Hermes, OpenClaw 등)를 감지해
연결하고, 연결된 에이전트를 통해 Sprintable을 **중앙 작업관리·스프린트관리·Data SoT**로 경험하게 한다.

핵심 원칙: **키 발급·배선·인증의 전 과정을 사용자에게 보이지 않게 한다.**
단, 성공은 조용히 / 실패는 또렷하게(§5.6).

---

## 2. 진단 (조사 근거)

### 2.1 "BYOM이 어렵다"의 재해석

최초 문제의식은 "모델 키 연결이 어렵다"였으나, 코드 조사를 거쳐 다음과 같이 정정한다.

| 층 | 실제 상태 | 근거 |
|---|---|---|
| 모델 키 | **기존 설계가 이미 해소** — 로컬 런타임이 자기 키를 보유 | 모든 커넥터가 요구하는 자격증명은 `AGENT_API_KEY` 하나뿐 (`connectors/*/README.md`) |
| 에이전트 배선 | **여기가 진짜 장벽** | 설치 + `AGENT_API_KEY` curl 발급 2회 + 환경변수 + `.mcp.json` 수동 편집 (`docs/agent-integration-guide.md` Step 1) |
| 서버측 BYOM | 프로덕션 호출자 없음 | `resolveLLMConfig`·`persist*`·`upsert*` 는 `apps/web/src/lib/llm/*` 와 테스트에서만 참조 |

**즉 "BYOM UX 개선"은 존재하지 말았어야 할 단계를 최적화하는 일이 될 위험이 있었다.**
기존 에이전트 모델(SSE dial-out + `AGENT_API_KEY` 단일 자격증명)이 이미 "모델 키를 서버로
보내지 않는다"를 전제하고 있었고, 이는 §5.1의 결론과 같은 방향이다.

### 2.2 변경 불가 제약 (검증됨)

- **SSE dial-out이 인바운드 요구를 제거한다** — 에이전트가 서버로 나가서 연결하므로 터널·웹훅 도메인 불필요. 로컬호스트 운용의 전제. (`docs/runtime-channel-map.md` §2, 5조 계약 ①)
- **런타임 자체가 CLI다** — 카테고리 B 4개(Codex/Gemini/Grok/Pi)가 모두 자식 프로세스를 spawn한다. **PTY는 필수.** (`connectors/README.md` 어댑터 카테고리)
- **Pi는 in-process 확장이라 "기존 세션"이 없다** — `~/.pi/agent/` 에 설정·확장만 있고 세션 저장소가 없음(실측). Pi의 강점(idle-wake 불필요)과 이 한계는 같은 사실의 양면. (`connectors/pi-sprintable/README.md`)
- **`agent_api_keys` 는 `key_hash` 만 저장** — 평문 재조회 불가. 발급 시 1회 표시가 설계 의도. (`backend/app/models/api_key.py:28`)
- **에이전트 생성은 admin 전용** — 대상 프로젝트 전원에 `min_role="admin"` 요구. 일반 멤버는 자기 에이전트를 못 만든다. (`backend/app/routers/agents.py:116`)

---

## 3. 확정 결정

| # | 결정 | 비고 |
|---|---|---|
| D1 | 데스크톱이 **모델을 직접 호출**한다 | 서버 경유 아님 |
| D2 | 자격증명 SoT 단위는 **조직** | 사용자가 정정: "데이터 단위"를 의미. 보관 주체가 아님 |
| D3 | 사용 범위는 **개인** | 조직 구성원 누구나 사용 |
| D4 | 키 캐싱 대신 **기기 자격증명** | 회전 폭발 반경 제거 |
| D5 | **멤버 셀프발급 허용** (개수 제한) | admin 병목 제거 |
| D6 | 에이전트 **사용자당 기본 1개** | 빌링 = 1좌석 |
| D7 | **로컬호스트 docker 실행** 지원 | `docker compose up -d` |
| D8 | 데스크톱은 **채팅 중심 앱** | 뷰어 없음. spawn은 헤드리스 |

### D2·D3의 정합성

D1+D2+D3 조합은 "조직이 키를 보관하고 개인 기기가 내려받는다"로 읽히면 **키 배포 시스템**이 되어
D3와 충돌한다("아무 팀원이나 조직 키를 꺼내갈 수 있다"). D2를 **소유·정책·감사의 단위**로 해석하면
충돌이 사라지고, 이는 기존 모델과도 일치한다 — `AGENT_API_KEY` 는 **Sprintable이 발급자**이므로
서버가 SoT일 수 있다. 모델 키(외부 발급)와 근본적으로 다르다.

---

## 4. 온보딩 비전

```
앱 설치 → 로그인 (클라우드 or 내 docker)
 └ 채팅 화면이 기본
 └ "에이전트 연결"
    ├ 로컬 런타임 감지 → 목록
    ├ 런타임 선택 → 로컬 세션 목록
    ├ 세션 클릭 → Sprintable 작업 컨텍스트 연결
    └ 조용히: self-issue → 기기 자격증명 → 키체인 → SSE dial-out
 └ 이후 모든 대화가 Sprintable conversation = Data SoT
```

### 단계별 실현 가능성

| 단계 | 판정 | 근거 |
|---|---|---|
| ① 에이전트 목록 | ✅ 쉬움 | CLI 존재 감지 + 홈 디렉터리. 실측 7개 전부 존재 |
| ② 로컬 세션 목록 | ⚠️ 가능, 런타임별 어댑터 5개 필요 | §4.1 |
| ③ 세션에서 이어서 연결 | ⚠️ "이어서"의 의미에 따라 갈림 | §4.2 |

### 4.1 세션 저장소 실측 (2026-09-14)

| 런타임 | 경로 | 형태 | 라벨 품질 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/` | 디렉터리명에 프로젝트 경로 인코딩 + JSONL | ✅ (272 파일) |
| Codex | `~/.codex/sessions/YYYY/MM/` | 날짜 트리, JSONL | ✅ (945 파일) |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite | ✅ |
| OpenClaw | `~/.openclaw/workspace-*/`, `tasks/` | 워크스페이스별 | ✅ (단 88,856 파일) |
| Hermes | `~/.hermes/` | DB + 스레드 | ✅ (단 179,459 파일) |
| Pi | `~/.pi/agent/` | **세션 저장소 없음** | ❌ |

**주의:** OpenClaw/Hermes는 파일 수가 5~6자리다. 필터 없이 순회하면 앱이 죽는다.

### 4.2 "이어서 연결"의 두 해석

- **(A) 그 세션의 컨텍스트를 물려받아 연결** — 런타임별 세션 재개 API에 의존. 가장 큰 신규 작업이고 불확실성이 높다.
- **(B) 그 세션을 참고 정보로만 쓰고 새로 연결** — 현 구조로 즉시 가능.

**권고: (B)부터, (A)를 런타임별 점진 추가.** 근거 —
③의 가치 원천은 로컬 세션 이력이 아니라 Sprintable 쪽 **작업 컨텍스트**다.
로컬 세션 매핑은 커넥터에서 **인메모리 `Map`** 이라 프로세스와 함께 사라지고
(`connectors/opencode-sprintable/index.ts:41`), Codex는 `thread/start` 로 매번 새 스레드를 만든다
(`connectors/codex-sprintable/host.py:193`, `persistExtendedHistory: False`).
즉 (A)는 매핑 영속화 + 런타임별 resume 검증을 선행 요구한다.

---

## 5. 설계

### 5.1 데이터 모델

```sql
CREATE TABLE public.agent_device_credentials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id         uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  agent_member_id   uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  device_label      text NOT NULL,
  public_key_der    bytea NOT NULL,
  key_fingerprint   text NOT NULL,
  status            text NOT NULL DEFAULT 'active',   -- active | revoked
  last_seen_at      timestamptz,
  last_server_seq   bigint,                  -- 리플레이 방어: 서버 발급 카운터(CAS)
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  UNIQUE (member_id, device_label)
);

CREATE INDEX ON public.agent_device_credentials (key_fingerprint) WHERE status = 'active';
```

- **평문 비밀 저장 안 함** — 공개키만. **개인키는 서버에 오지 않는다.**
- **`dt_live_` 는 토큰이 아니라 기기 식별자다** (2026-09-14 정정). 장수명 bearer 비밀이
  존재하지 않으므로 탈취할 토큰이 없다. `sk_live_` 와 섞이지 않도록 접두사로 분리.
- **계층적 증명** — 키쌍 기기 증명(서명)은 항상, 앱 무결성(attestation)은 자체호스팅에서만
  생략. "무증명"이 아니다.
- `device_installations`(`backend/app/models/device_installation.py`) 구조를 참고하되, 그것은
  App Attest/Play Integrity 기반 **앱 무결성 증명**이라 데스크톱용은 목적이 다르다 — 개념만 차용.

### 5.2 인증 확장 — 초크포인트 1곳

`backend/app/dependencies/auth.py` 의 **`AuthContext` 형태**가 초크포인트다 — 엔드포인트를
고칠 필요가 없다. (초판은 "함수 1개 `_resolve_api_key()`"라고 적었는데, 그 함수는 얇은 조회가
아니라 8단계 파이프라인이라 `dt_live_` 분기를 안에 넣지 않는다 — §5.2.1 참조.)

**구현됨(2026-09-16).** 신규 `_resolve_device_credential()` 이 `sk_live_` 와 **같은
`AuthContext`** 를 내고, `get_current_user`·`get_current_user_streaming` 두 변형이 접두사로
분기한다(`dt_live_` 는 x-agent-api-key 헤더 경로에 붙이지 않는다 — 그 표면은 SSE 브릿지 전용).

```
get_current_user / get_current_user_streaming:
  if credential.startswith('dt_live_'):
      → _resolve_device_credential()  (전용 세션, 즉시 close)
      → 기기 식별자로 agent_device_credentials 조회
        (status='active', revoked_at IS NULL)
      → 요청 서명을 등록된 public_key 로 검증
      → 타임스탬프 허용 윈도우 + 리플레이 방어 확인
      → member_id / org_id / agent_member_id 해소, last_seen_at 갱신(스로틀)
  else:  # sk_live_ — 기존 경로 한 줄도 변경 없음
      → _resolve_api_key() 현행 유지
```

**기존 `sk_live_` 경로 불변이 회귀 위험을 최소화하는 지점이다.**

⚠️**함께 고쳐야 했던 것(구현 중 실측):** `api_key_id` claim 의 truthiness 로 "에이전트인가"를
판정하던 소비처 22곳이 `dt_live_` 를 human 분기로 떨어뜨려 하드 실패했다(400/404). 판정은
`is_agent_credential()` 하나로 수렴하고, 그 함수가 **과금 판별자(`is_au_billable_agent`)와
같은 축**을 공유한다 — 둘이 갈라지면 과금과 인가가 어긋난다.

### 5.2.1 `AuthContext` claim — 에이전트 판별 축 (2026-09-15 확정)

`_resolve_api_key` 는 얇은 조회가 아니라 **8단계 파이프라인**이다(401 원장·readiness 계측·
`first_auth_seen`·`last_used_at` 스로틀·사용 이력·`scope`·`project_ids` 산출). 그래서
`dt_live_` 를 그 안에 넣지 않고, **같은 `AuthContext` 를 내는 신규 함수**로 둔다.

**claim 형태 — `api_key_id` 를 싣지 않는다:**

```python
claims={"app_metadata": {
    "device_credential_id": "<uuid>",   # 기기 자격증명 식별자 (ApiKey 아님)
    "actor_type": "agent",              # ← 판별·과금 축
    "org_id": ..., "project_id": ..., "project_ids": [...], "scope": [...],
}}
```

**근거 — `auth.py:452~465` 가 직접 처방을 적어놨다:**

```python
⛔단순히 `api_key_id` claim 존재만 보면 안 된다 — `_resolve_human_api_key`(hu_live_*,
휴먼 개인 API key)가 `"human_api_key_id"`로 싣고 `"actor_type": "human"`을 명시하는
기존 예외 경로가 있다. 그 경로를 에이전트로 오분류하면 사람 UI/개인키 작업에 AU를
잘못 부과해 스펙(사람=0)을 위반한다. 판별자는 반드시 이 둘을 함께 본다.
```
```python
is_api_key = bool(app_metadata.get("api_key_id"))
is_human_claimed = app_metadata.get("actor_type") == "human"
return is_api_key and not is_human_claimed
```

`hu_live_*` 선례(`auth.py:302`)가 같은 방식을 쓴다 — *"`human_api_key_id` 로만 싣는다
(이름이 달라 어떤 기존 소비처의 `api_key_id` 판정도 …)"*.

**그리고 claim 의 `api_key_id` 는 `ApiKey` 로 «조회되지 않는다»**(READ 실측):

| 소비 방식 | 개수 |
|---|---|
| `bool(meta.get("api_key_id"))` — truthiness | **22곳**(READ 추정 ~15 는 과소 — 구현 중 실측) |
| `== "system-publisher"` — 합성값 비교 | 1곳 (`events.py:1837`) |
| **`ApiKey` 로 조회** | **0곳** |

값이 식별자로 소비되지 않으므로 합성값(`system-publisher` 선례)도 가능하지만, **정답은
`api_key_id` 를 비우고 `actor_type` 을 명시하는 것**이다:

1. **AU 과금이 맞게 잡힌다.** 데스크톱 에이전트는 자동화 트래픽 → AU 부과 대상.
   `api_key_id` 가 없으면 `is_api_key=False` → **AU 0 = 과금 누락**.
2. **`actor_type: "agent"` 명시가 그걸 고친다** — 코드가 "반드시 이 둘을 함께 본다"고 했다.
3. **`api_key_id` 를 안 실어 `hu_live_` 선례로 안전** — 기존 truthiness 판정을 오염시키지 않는다.

⚠️ **비용:** `bool(meta.get("api_key_id"))` 를 쓰는 **22곳**은 device 를 휴먼/익명으로
본다. 그중 **관리자 권한·데이터 스코프가 걸린 곳은 `actor_type` 도 함께 보도록 고쳐야**
한다. 과금 축은 이미 그렇게 되어 있으니, 나머지를 같은 형태로 맞추는 일이다 → **G10**

**✅ 완료(2026-09-16).** 22곳을 `is_agent_credential(auth)` 로 교체했다. 그중 셋은
**기능이 막혀 있던 자리**였다 — `agent_gateway` 의 SSE 스트림·ACK(`dt_live_` 가 403),
`project_scope.enforce_write_scope`(scope 검사가 통째로 스킵 → admin-adjacent 표면 무검사),
`mcp` manifest(MCP 경로 전면 403). 남은 잔존은 저장소 전역 소스 스캔 가드가 막는다.

**커넥터는 수정하지 않는다.** SDK 가 자격증명을 정적 bearer 문자열로 싣기 때문에
(`connectors/sdk/sprintable-sse.ts:65`), 서명은 **로컬 프록시**가 만든다:

```
커넥터 → SPRINTABLE_API_URL=http://127.0.0.1:<port>   (로컬 프록시)
       AGENT_API_KEY=<아무 값>                        (프록시가 대체)
         ↓
로컬 프록시 (데스크톱 앱) — 키체인의 개인키로 매 요청 서명
         ↓
Sprintable 서버 — 공개키로 서명 검증
```

이유: SDK 사본이 **8개**(sdk·opencode·openclaw·pi·connectors-pkg·hermes×2)이고
`pi-sprintable/README.md` 가 이미 그 벤더링을 부채로 추적한다(`project_vendored_sdk_sync_debt`).
거기에 서명 로직을 8곳 심으면 조용한 보안 드리프트가 된다. `sk_live_` 는 데스크톱이
없는 CLI 수동 설치 경로에 그대로 남는다.

### 5.3 셀프 발급

기존 `agents.py` 의 admin 요구는 **건드리지 않는다**(관리자 경로 보안이 함께 약해진다).
별도 엔드포인트를 추가한다.

```
POST /api/v2/agents/self-issue
  인가: 대상 프로젝트 member 이상 (admin 불요)
  제약: 본인 소유 agent 수 < limit (D6: 기본 1)
  결과: agent member 1개 + 프로젝트 grant, 빌링 1좌석
```

규칙이 느슨한 게 아니라 **적용 범위가 다르다** — "본인 것 1개"라 남의 것을 못 만들고 상한이
escalation을 막는다. 참고: 기존 `POST /api/v2/agents` 는 이미 org 스코프로 키 1개 + N grant를
fan-out 하며 빌링=1좌석이다 (`apps/web/src/app/api/agents/route.ts`).

### 5.4 로컬 / 서버 두 실행 경로

| | 데스크톱 (로컬) | 서버 (managed) |
|---|---|---|
| 생성 | `POST /api/v2/agents/self-issue` | `POST /api/v1/agent-deployments` |
| 런타임 | spawn (codex/gemini/grok/pi) | `runtime: 'webhook' \| 'openclaw'` |
| 인바운드 | SSE dial-out | webhook POST |
| 모델 키 | 기기 (런타임 보유) | 서버 KMS (`llm_mode: 'byom'`) |
| 사용자 개입 | 클릭 1~2회 | 0회 |

**서버 경로는 신규 설계가 아니다** — 기존 `agent_deployments` 를 UI에 노출하는 일이다.
두 경로가 같은 에이전트 레지스트리(`team_members`, `type='agent'`)를 공유하므로
UI는 **"이 컴퓨터에서 실행 / 클라우드에서 실행" 토글 하나**로 갈라준다.
기존 계약(`docs/managed-agent-deployment-contract.md`)의 "BYOM 배포는 암호화된 project AI
자격증명을 재사용한다"는 조항은 **서버 경로 전용**으로 유지된다.

### 5.5 데스크톱 앱 형태

| | 웹 (`apps/web`) | 데스크톱 (신규) |
|---|---|---|
| 채팅 UI | 38개 컴포넌트 + 유틸 (테스트 포함 104개) | 재사용 여부 **미결** (§9-1) |
| 자식 프로세스 spawn | ❌ | ✅ |
| 로컬 세션 접근 | ❌ | ✅ |
| OS 키체인 | ❌ | ✅ |

**데스크톱에서 진짜 새로운 것은 spawn · 로컬 세션 · 키체인 셋뿐이다.**
나머지(채팅·보드·스프린트)는 이미 웹에 있다.

Hermes Desktop / Buzz와의 차이: 그쪽은 **로컬 우선**(서버가 선택)이나, Sprintable은 **서버가 제품**이다
(보드·스토리·라우팅 규칙·Data SoT가 전부 서버). 데스크톱은 서버에 로컬 에이전트를 붙이는 **얇은 클라이언트**다.
따라서 온보딩이 로그인으로 시작하는 것이 자연스럽다.

**배포 형태 2종을 동시 지원하는 것이 이 제품의 정체성이다:**

```
형태 1: 데스크톱 + 클라우드 서버   ← 일반 사용자
형태 2: 데스크톱 + 로컬 docker     ← 개발자 / 자체호스팅 / 폐쇄망
```

같은 앱, 다른 `APP_BASE_URL` 하나.

### 5.6 "사용자가 모르도록"의 경계

| | 사용자 | 조직 |
|---|---|---|
| 성공 | 아무것도 안 보임 | `agent_api_key_usage_log` 기록 |
| 실패 | 한 줄 (만료/무효화/인식 불가) | presence auth-failure |

성공도 실패도 안 보이면 고장 시 아무도 설명할 수 없다. **필수 예외:**
"이 기기 연결됨 / 해제" 표면 하나는 반드시 둔다 — 자기가 승인한 것을 모르는 상태는
보안 리뷰에서 막힌다. 사용자에게 보이는 유일한 상시 표면이어야 한다.

---

## 6. 자체호스팅 (D7)

### 6.1 이미 되어 있는 것

`docker compose up -d` 한 줄로 `db` + `backend` + `frontend` 기동(`docs/self-hosting.md`).
자체호스팅을 위한 조정이 이미 곳곳에 있다:

- `SPRINTABLE_LOCAL_DEV: "1"` — Cloud Run 전용 cron/firebase 시크릿 게이트의 startup fail-closed 방지
- `REQUIRE_VERIFIED_EMAIL_FOR_ORG_CREATE: "False"` — 메일 발송기 없는 환경에서 org 생성 403 루프 완화
- `bootstrap.py` → `alembic upgrade heads` 로 baseline 자동 적용
- backend healthcheck로 기동 순서 보장
- `APP_BASE_URL` 기본값이 이미 `http://localhost:3108`

> ⚠️ 위는 compose/문서를 읽은 결과다. 실제 `docker compose up` 실행 검증은 미실시 —
> **작업 머신에 Docker Desktop 이 설치돼 있지 않다**(2026-09-14 실측: `docker` CLI 부재,
> `/Applications/Docker.app` 없음). 코드 갭이 아니라 환경 제약이므로, Docker 가 있는
> 머신에서 `make up` 으로 닫아야 한다.
>
> 대신 스크립트 계층은 격리 검증했다: `init-env.py` 를 임시 디렉터리에서 실행해
> 4개 시크릿(JWT/SECRET/POSTGRES/KMS) 전부 32자 이상 생성 + 플레이스홀더 잔존 0 +
> 키 구조 불변(`diff` 로 확인), `validate-env.sh` 3케이스(키 있음→통과 / 키 없음→경고
> 후 exit 0 / `NEXT_PUBLIC_APP_URL` 없음→차단 exit 1) 전부 의도대로.

### 6.2 갭 3개 — **①·② 해소 완료 (2026-09-14)**

**① `LOCAL_KMS_MASTER_KEY` 미배선 — 해소**

```
KMS_PROVIDER 미설정 → 기본 'local'
LocalKmsAdapter 생성자 → if (!secret) throw 'LOCAL_KMS_MASTER_KEY is required'
```

`apps/web/src/lib/kms/provider.ts:43`. `.env.example`(키 10개)과 compose 어디에도 없었다.
현재는 `resolveLLMConfig` 에 프로덕션 호출자가 없어 안 터지지만, **이 프로젝트가 그 호출자를
만드는 일**이므로 day-one 블로커가 된다.

**조치:**
- `.env.example` 에 `LOCAL_KMS_MASTER_KEY=generate-with-openssl-rand-hex-32` 추가.
  `init-env.py` 의 플레이스홀더 치환은 **문자열 일치**이므로 기존 `change-me-*` 와 충돌하지
  않는 고유 문자열을 썼다.
- `scripts/init-env.py` PLACEHOLDERS 에 생성기 등록(`secrets.token_hex(32)`).
  실측: 4개 키(JWT/SECRET/POSTGRES/KMS) 전부 32자 이상으로 치환되고 키 구조는 불변.
- `docker-compose.yml` frontend 에 `LOCAL_KMS_MASTER_KEY` + `KMS_PROVIDER` 배선.
- `scripts/validate-env.sh` 에 경고 추가 — **차단하지 않는다.** BYOM 을 아직 안 쓰는 설치는
  정상 기동해야 하므로, 첫 BYOM 저장 시점에 실패하는 편이 낫다.
- 검증: `token_hex(32)` 와 `openssl rand -hex 32` 모두 64자 hex → `normalizeMasterKey` 의
  1순위 분기(`/^[A-Fa-f0-9]{64}$/`)에서 **32바이트 키**로 수용됨(AES-256 요구 충족).

**키 위치는 frontend 다.** `lib/llm/client.ts` 가 `fetch` 로 모델을 호출하는 주체이고 그 파일이
`apps/web` 에 있기 때문. backend(Python)는 BYOM 암호문을 복호화하지 않는다 — 채널 자격증명은
`channel_credential_crypto.py` 로 완전히 별개 경로다.

**② `extra_hosts` 누락 — 해소**

Ollama/LM Studio는 호스트, 서버는 컨테이너. Docker Desktop은 암묵 제공하나
**Linux는 명시 필요**. frontend 에 배선했다:

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

baseUrl은 `http://host.docker.internal:11434/v1` — `validateCustomEndpoint` 의 `/v1` 요구를 통과.

**③ 모델 키 주입 경로가 컨테이너 환경변수뿐 — 잔존**

`resolveLLMConfig` 의 폴백은 컨테이너 **내부** `process.env.*` 를 읽는다. 이는 키를
`.env` 평문 + 컨테이너 환경에 남긴다는 뜻이다. 로컬 BYOM의 정당한 경로는 환경변수가 아니라
**DB의 암호화 시크릿(①의 `local` KMS 경로)** 이어야 한다.
①은 이제 키를 **제공**하지만, BYOM **저장 경로 자체가 아직 없다**(§2.1 — 프로덕션 호출자 0).
따라서 ③은 저장 경로를 만드는 시점에 함께 해소된다.

### 6.3 로컬 인스턴스에서 파생되는 제약

- `local` KMS 마스터 키는 인스턴스마다 다르므로 **BYOM 설정은 그 인스턴스에만 유효**하다.
  이는 D1의 기기-우선 방향과 일관되나 **문서화가 필요**하다.
- 기기 자격증명이 **평문 HTTP 로컬호스트**(`http://localhost:3108`)에서 동작해야 한다.
  `device_proof` 는 HTTPS + 앱 무결성을 전제하므로 **로컬 dev 모드**가 필요하고,
  그만큼 **보안 강도가 모바일 경로보다 낮다** (§8).

---

## 7. 빌드 순서

| 순서 | 작업 | 레포 |
|---|---|---|
| ~~1~~ | ~~`LOCAL_KMS_MASTER_KEY` 배선 + 셋업 스크립트~~ | ✅ 완료 (§6.2 ①) |
| ~~2~~ | ~~`extra_hosts` + 로컬 LLM 문서~~ | ✅ 완료 (§6.2 ②) |
| ~~3~~ | ~~`agent_device_credentials` + 인증 분기~~ | ✅ 완료 (2026-09-16, §5.2) |
| 4 | `self-issue` (멤버 셀프발급, 상한 1) | 이 레포 (백엔드) |
| 5 | conversation ↔ 로컬 세션 매핑 모델 (1:N) | 이 레포 (백엔드) |
| 6 | 기기 등록 로컬 dev 모드 | 이 레포 (백엔드) |
| 7 | 데스크톱: 런타임 감지 + 키체인 + spawn + SSE | **다른 레포** |
| 8 | 데스크톱: 세션 목록 어댑터 (Claude/Codex/OpenCode/OpenClaw/Hermes) | **다른 레포** |
| 9 | (A) 세션 재개 — 런타임별 점진 | 둘 다 |

**1~6번이 이 레포 안, 백엔드다.** 데스크톱(7~8) 없이도 `docker compose up` 으로 검증 가능하다.
9번이 가장 불확실하다.

**1·2번 완료(2026-09-14) · 3번 완료(2026-09-16).** 3번은 등록·폐기 라우터
(`POST/DELETE /api/v2/device-credentials`), `dt_live_` 인증 해소, 리플레이 방어(CAS),
판별 축 정합까지 포함한다. `docker compose up` 실증은 이 머신에 Docker 부재로 **미실시**이며,
다음 착수 지점은 4번(`self-issue`)이다.

---

## 8. 리스크

| 리스크 | 내용 | 완화 |
|---|---|---|
| **세션 이력 = 개인정보** | `~/.claude/projects/*.jsonl` 에 대화 전문이 있다. 데스크톱이 파싱해 서버로 올리면 유출 | 로컬에서만 읽고 서버엔 메타데이터(프로젝트·시각)만 전송 |
| **Pi 미지원** | 세션 저장소가 없어 온보딩 목록에 못 뜬다 | 비전에서 Pi 제외를 명시하거나, "실행 중 세션에 붙기"로 별도 처리 |
| **기기 상한 없음** | 에이전트는 사용자당 1개인데 기기 무제한이면 좌석 1·스트림 N | `_AGENT_STREAM_TIER_LIMITS`(free 3/team 15/pro 30) 안에서 상한 결정 |
| ~~**`dt_live_` 수명 미정**~~ | — | **소멸** — 토큰이 아니라 기기 식별자라 수명·갱신 문제 자체가 없다(§9-6). 그 자리를 서명 타임스탬프 윈도우 + 리플레이 방어가 대체 |
| **로컬 dev 보안 강도** | 평문 HTTP + attestation 생략 | 감수 여부 결정. 자체호스팅 한정 여부 |
| **웹 채팅 이중 유지** | 채팅 컴포넌트 38개(+유틸)를 재구현하면 유지보수 2배 | §9-1 결정 |
| **파일 규모** | OpenClaw 88,856 / Hermes 179,459 파일 | 필터 필수 |

---

## 9. 미결 사항

1. **웹 채팅을 데스크톱에서 어떻게 쓸 것인가** — (A) 웹을 감싸기 / (B) 채팅만 재구현 /
   (C) 웹 컴포넌트 임베드. **데스크톱 전체 공수를 좌우한다.** (권고: A — 차별점은 채팅 UI가 아니라 spawn·세션·SoT)
2. **"이어서 연결"의 의미** — (A) 컨텍스트 승계 vs (B) 참고용. (권고: B부터)
3. **세션 내용을 서버로 보내는가** — 보안 결정. (권고: 로컬 전용)
4. **Pi를 어떻게 할 것인가** — 제외 / 별도 처리
5. **에이전트 1 : 세션 N 매핑을 Sprintable에 저장하는가** — 저장하면 세션 목록이 기기 간 공유,
   안 하면 기기마다 별도
6. ~~**기기 상한** 및 **`dt_live_` 수명·갱신 정책**~~ — **둘 다 확정**
   (2026-09-14). `dt_live_` 는 토큰이 아니라 **기기 식별자**이고 서명은 매 요청
   생성되므로 갱신할 것이 없다. 그 자리를 **서명 타임스탬프 윈도우 + 리플레이 방어**가
   대체한다. **기기 상한은 제품 정책으로 만들지 않는다** — 자원 보호는 기존 per-agent
   동시 스트림 제한(free 3 / team 15 / pro 30)이 이미 담당하므로, 상한을 추가하면
   드리프트하는 두 번째 숫자만 생긴다. 남용 방어용 상한 50 만 두고 "정책 아님"으로 둔다
7. ~~**로컬 dev 모드 보안 강도** 감수 여부~~ — **확정 (2026-09-14)**: 계층적 증명.
   키쌍 증명은 항상, **앱 무결성만** 자체호스팅에서 생략. 조건 3개 — 호스팅에서
   도달 불가 / 감사 기록(`attestation_type`) / 사용자 문서에 강도 차이 명시

---

## 10. 참조

- [`docs/runtime-channel-map.md`](./runtime-channel-map.md) — 4개 채널·5조 계약. **본 설계의 전제**
- [`docs/managed-agent-deployment-contract.md`](./managed-agent-deployment-contract.md) — 서버 실행 경로 계약 (`llm_mode`)
- [`docs/self-hosting.md`](./self-hosting.md) — docker 자체호스팅
- [`docs/agent-integration-guide.md`](./agent-integration-guide.md) — 현재 온보딩 마찰의 실체
- [`connectors/README.md`](../connectors/README.md) — 어댑터 카테고리 A/B/C, 새 어댑터 체크리스트
- [`connectors/pi-sprintable/README.md`](../connectors/pi-sprintable/README.md) — in-process vs 자식 프로세스, idle-wake
- `apps/web/src/lib/llm/config.ts` · `apps/web/src/lib/kms/provider.ts` — KMS/BYOM 현재 구현
- `backend/app/dependencies/auth.py` — **인증 초크포인트 `_resolve_api_key`**
- `backend/app/routers/agents.py` · `backend/app/models/api_key.py` — 발급·해싱
- `apps/web/src/components/chat/` — 웹 채팅 컴포넌트 38개(+유틸 9, 테스트 포함 총 104파일)
- 외부: `moonklabs/sprintable-agent-plugins` (`plugins/sprintable`, Claude Code 배포 경로)
