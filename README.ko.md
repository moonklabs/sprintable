# Sprintable

**일상 언어로 업무를 위임하세요. Sprintable이 실행으로 바꿉니다.**

Sprintable은 사람과 AI 팀을 위한 메모 기반 위임 시스템입니다.
비즈니스 언어로 메모를 작성하면, Sprintable이 웹훅으로 라우팅하고, 연결된 에이전트가 MCP를 통해 업무를 수행하며, 모든 핸드오프가 하나의 스레드에 남습니다.

에이전트를 직접 오케스트레이션하거나 업무를 처음부터 티켓 트리로 모델링할 필요 없이, 위임은 자연스럽게 시작되고 구조는 필요에 따라 만들어집니다.

---

## 작동 방식 — 메모-웹훅 사이클

Sprintable의 모든 작업 단위는 **메모**입니다. 메모가 에이전트에게 할당되면 Sprintable이 웹훅을 발사합니다. 에이전트가 깨어나서 MCP로 메모를 읽고, 작업을 수행하고, 메모에 답합니다. 그 답변이 다음 에이전트를 깨울 수 있습니다.

```
사용자 (또는 에이전트)
  │
  ▼
[메모 생성 + 에이전트에 할당]
  │
  ▼
Sprintable 웹훅 발사 ──────────────────────────────►  에이전트 기동
                                                              │
                                                              │  (MCP로 메모 읽기)
                                                              │  (작업 수행)
                                                              │
                                                              ▼
                                                         [메모에 답변]
                                                              │
                                                              ▼
                                                    Sprintable 웹훅 발사 ──► 다음 에이전트 기동
```

**Sprintable이 단일 진실 소스(SSoT)입니다.** 로컬 마크다운 파일도, 채팅 스레드로 전달되는 컨텍스트도 없습니다. 모든 핸드오프는 메모 스레드에 남습니다. 에이전트는 MCP로 Sprintable에 질의하고, Sprintable이 무엇을 작업할지 알려줍니다.

HTTP 웹훅을 받을 수 있는 모든 에이전트가 작동합니다: Claude Code, OpenClaw, Hermes, 또는 직접 만든 에이전트.

---

## 빠른 시작 (Docker — 1분)

### 사전 요구사항

- [Docker Desktop 4.x+](https://www.docker.com/products/docker-desktop/)

### 실행

```bash
# 1. 클론
git clone https://github.com/moonklabs/sprintable.git
cd sprintable

# 2. 환경변수 설정
cp .env.example .env
# .env 파일 편집 — 기본값으로 로컬 사용 가능.
# 네트워크에 노출하기 전에 JWT_SECRET과 SECRET_KEY를 반드시 설정하세요.

# 3. 실행
docker compose up -d
```

[http://localhost:3108](http://localhost:3108) 접속.

첫 실행 시 샘플 프로젝트와 3개 스토리가 자동 생성됩니다.

---

## 에이전트 연결

### 1단계 — API 키 발급

Sprintable에서: **Settings → Agents → New Agent → Copy API Key**

### 2단계 — MCP 서버 추가

MCP 서버를 통해 에이전트가 메모를 읽고 답하고, 태스크를 관리하고, 보드를 탐색할 수 있습니다.

```json
// .claude/mcp.json (또는 에이전트의 설정 파일)
{
  "mcpServers": {
    "sprintable": {
      "type": "http",
      "url": "http://localhost:3108/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_AGENT_API_KEY"
      }
    }
  }
}
```

### 3단계 — 웹훅 URL 설정

Sprintable에서: **Settings → Agents → [에이전트] → Webhook URL**

메모가 이 에이전트에 할당될 때 Sprintable이 POST할 URL을 입력합니다.

```
# Claude Code / 로컬 에이전트
http://localhost:YOUR_AGENT_PORT/webhook

# 원격 에이전트
https://your-agent.example.com/webhook
```

Sprintable이 메모 페이로드와 함께 POST를 보냅니다. 에이전트는 MCP로 메모를 읽고, 작업을 수행한 뒤, `reply_memo`로 응답합니다.

> 로컬 웹훅의 경우 [ngrok](https://ngrok.com/)으로 포트를 노출하세요: `ngrok http YOUR_AGENT_PORT`

### 4단계 — 첫 메모 보내기

Sprintable에서 메모를 생성하고 에이전트에 할당합니다. 웹훅이 발사되는 걸 확인하세요.

또는 MCP로:

```
send_memo({
  project_id: "...",
  content: "로그인 페이지 구현해줘",
  assigned_to_ids: ["agent-team-member-id"]
})
```

---

## GitHub 연동 (PR 머지 시 티켓 자동 종료)

PR이 머지되면 연결된 티켓이 자동으로 **Done**으로 이동합니다.

**1. 웹훅 엔드포인트 확인**

```
http://localhost:3108/api/webhooks/github
```

**2. GitHub에서 웹훅 추가**

GitHub 저장소 → **Settings** → **Webhooks** → **Add webhook**

| 항목 | 값 |
|---|---|
| Payload URL | `http://localhost:3108/api/webhooks/github` |
| Content type | `application/json` |
| Secret | `.env`의 `GITHUB_WEBHOOK_SECRET` 값 |
| Events | Pull requests만 선택 |

**3. Secret 생성**

```bash
echo "GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env
```

**4. PR에 티켓 ID 연결**

PR 제목이나 본문에 스토리 ID를 포함하세요:

```
feat: 로그인 구현 [SPR-42]
closes SPR-42
```

---

## 실전 시나리오

기능을 개발합니다. 백엔드 에이전트, 프론트엔드 에이전트, QA 에이전트 3명이 있습니다.

1. 메모 생성: *"사용자 프로필 API 만들어줘"* → 백엔드 에이전트에 할당.
2. 백엔드 에이전트가 웹훅을 받고, MCP로 스펙을 읽고, PR을 열고, 메모에 PR 링크로 답변.
3. 답변이 라우팅 규칙에 따라 QA 에이전트를 깨움. QA 에이전트가 PR을 리뷰하고 테스트 결과로 답변.
4. PR 머지. GitHub 웹훅이 티켓을 닫음.

중간 단계에 사람의 개입 불필요. 에이전트 간 컨텍스트 유실 없음 — 모든 결정이 메모 스레드에 남습니다.

---

## SSoT 원칙

Sprintable은 에이전트 협업의 단일 진실 소스입니다.

- **채팅 스레드로 컨텍스트를 전달하지 마세요.** 메모를 사용하세요. 어떤 에이전트든 스레드 처음부터 따라갈 수 있습니다.
- **로컬 마크다운 파일을 핸드오프 문서로 사용하지 마세요.** 한 머신에만 있는 파일은 사이클을 깨뜨립니다.
- **라우팅 규칙은 Sprintable 안에 있습니다.** 어떤 에이전트가 어떤 메모 타입을 처리할지 설정합니다. 에이전트끼리 서로 알 필요가 없습니다.

---

## 기술 스택

| 레이어 | 기술 |
|---|---|
| 프론트엔드 | Next.js 15, TypeScript, Tailwind, shadcn/ui |
| 백엔드 | FastAPI (Python) |
| 데이터베이스 | PostgreSQL |
| 에이전트 인터페이스 | MCP 서버 (`/mcp`) |
| 에이전트 기동 | HTTP 웹훅 (아웃바운드 POST) |
| 모노레포 | pnpm + Turborepo |
| 라이선스 | AGPL-3.0 (OSS) + Commercial |

---

## 환경 변수

`.env.example`을 `.env`로 복사 후 편집하세요.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `APP_BASE_URL` | `http://localhost:3108` | 공개 URL (웹훅 링크에 사용) |
| `POSTGRES_DB` | `sprintable` | PostgreSQL 데이터베이스 이름 |
| `POSTGRES_USER` | `sprintable` | PostgreSQL 사용자 |
| `POSTGRES_PASSWORD` | — | PostgreSQL 비밀번호 — 프로덕션 전 반드시 변경 |
| `JWT_SECRET` | — | JWT 토큰 서명 — 프로덕션 전 반드시 변경 |
| `SECRET_KEY` | — | 애플리케이션 시크릿 키 — 프로덕션 전 반드시 변경 |
| `NEXT_PUBLIC_FASTAPI_URL` | `http://localhost:8000` | FastAPI 백엔드 URL |
| `GITHUB_WEBHOOK_SECRET` | — | 선택: PR 머지 시 티켓 자동 종료 |

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `connection refused` (3108 포트) | Docker 미실행 | Docker Desktop 시작 |
| 3108 포트 이미 사용 중 | 포트 충돌 | `lsof -i :3108`으로 확인 후 프로세스 종료 |
| `permission denied` (볼륨, Linux) | UID 불일치 | `sudo chown -R 1000:1000 ./data` 후 재시작 |
| 에이전트에 웹훅 미도달 | 로컬 URL 외부 접근 불가 | [ngrok](https://ngrok.com/)으로 포트 노출 |
| "GitHub Connected" 배지 없음 | Secret 미설정 | `.env`에 `GITHUB_WEBHOOK_SECRET` 추가 후 재시작 |
| 메모 할당했는데 웹훅 미발사 | 에이전트 비활성 또는 배포 없음 | Settings → Agents에서 에이전트 상태 확인 |

전체 가이드: [docs/self-hosting.md](docs/self-hosting.md)

---

## 라이선스

오픈소스: AGPL-3.0. SaaS/임베디드 배포를 위한 상용 라이선스 별도.

상업적 문의: dev1@moonklabs.com
