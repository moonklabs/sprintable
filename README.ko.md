# Sprintable

PR이 머지되면 티켓이 자동으로 닫히는 AI PM 도구. Self-host, 로컬 LLM 지원.

## 시작하기

### 사전 요구사항

- [Docker Desktop 4.x+](https://www.docker.com/products/docker-desktop/) 설치
- GitHub 저장소 (webhook 연동용)

### 1분 설치

```bash
# 1. 저장소 클론
git clone https://github.com/moonklabs/sprintable.git
cd sprintable

# 2. 환경변수 설정
cp .env.example .env
# .env 파일을 열어 NEXTAUTH_SECRET 값 설정:
# NEXTAUTH_SECRET=$(openssl rand -base64 32)

# 3. 실행
docker compose -f docker-compose.oss.yml up
```

→ http://localhost:3108 에서 Sprintable 접속

<!-- 스크린샷: 샘플 프로젝트 "Hello Sprintable"이 있는 칸반 보드 -->
![Sprintable 보드](docs/screenshots/board-sample.png)

첫 실행 시 샘플 프로젝트("Hello Sprintable")와 3개의 샘플 스토리가 자동으로 생성됩니다.

---

## GitHub Webhook 연동 (5단계)

PR을 머지하면 연결된 티켓이 자동으로 "Done"으로 이동합니다.

**1단계 — Webhook URL 확인**

```
http://localhost:3108/api/webhooks/github
```

외부 서버 배포 시: `https://your-domain.com/api/webhooks/github`

> 로컬 개발 중이라면 [ngrok](https://ngrok.com/)으로 외부 URL을 생성하세요:
> ```bash
> ngrok http 3108
> ```

**2단계 — GitHub 저장소 설정 열기**

GitHub 저장소 → **Settings** → **Webhooks** → **Add webhook**

**3단계 — Webhook 설정**

| 항목 | 값 |
|---|---|
| Payload URL | `http://localhost:3108/api/webhooks/github` |
| Content type | `application/json` |
| Secret | `.env`의 `GITHUB_WEBHOOK_SECRET` 값 |
| Events | **Let me select individual events** → **Pull requests** 체크 |

**4단계 — Secret 설정**

`.env` 파일에서 `GITHUB_WEBHOOK_SECRET` 값을 복사해 GitHub webhook secret에 붙여넣습니다.

```bash
# .env에 없다면 새로 생성:
echo "GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env
```

**5단계 — 연동 확인**

Webhook 저장 후 GitHub가 ping 이벤트를 보냅니다. Sprintable 보드 우상단에
**"GitHub Connected ✓"** 배지가 표시되면 성공입니다.

---

## 성공 확인

```bash
# Webhook 엔드포인트 응답 확인 (서명 없이 → 400 반환이 정상)
curl -X POST http://localhost:3108/api/webhooks/github \
  -H "Content-Type: application/json" \
  -d '{}' \
  -w "\nHTTP %{http_code}\n"
# 예상 출력: HTTP 400 (서버가 살아있다는 증거)
```

PR 제목이나 본문에 티켓 ID를 포함하면 자동으로 닫힙니다:
- `feat: 로그인 구현 [SPR-42]`
- `closes SPR-42`
- `fixes #SPR-42`

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `connection refused` | Docker daemon 미실행 또는 포트 충돌 | Docker Desktop 실행 확인; `lsof -i :3108`으로 포트 점유 확인 후 종료 |
| `localhost:3108` 응답 없음 | Mac Docker Desktop bridge 네트워크 문제 | Docker Desktop 재시작; 또는 `docker compose -f docker-compose.oss.yml down && up` 재실행 |
| `permission denied` on volume | UID 불일치 (Linux) | `sudo chown -R 1000:1000 ./data` 실행 후 재시작 |
| Webhook이 작동 안 함 | 로컬 URL은 GitHub에서 접근 불가 | [ngrok](https://ngrok.com/) 또는 외부 서버 배포 필요 |
| GitHub Connected 배지 없음 | `GITHUB_WEBHOOK_SECRET` 미설정 | `.env`에 `GITHUB_WEBHOOK_SECRET` 추가 후 재시작 |

전체 트러블슈팅: [docs/self-hosting.md](docs/self-hosting.md)

---

## 고급 기능 (첫 성공 후)

<details>
<summary>Claude Code / Cursor MCP 통합 (AI 코파일럿)</summary>

```json
// .claude/mcp-settings.json 또는 Cursor settings
{
  "mcpServers": {
    "sprintable": {
      "url": "http://localhost:3108/mcp",
      "apiKey": "your-agent-api-key"
    }
  }
}
```

</details>

<details>
<summary>BYOA — 내 AI 키 연결</summary>

`.env`에 원하는 LLM 키 추가:

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
# 또는 로컬 Ollama
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
```

</details>

<details>
<summary>기술 스택</summary>

- Next.js 16, TypeScript, Tailwind CSS, shadcn/ui
- SQLite (OSS) / Supabase (Cloud)
- pnpm monorepo

</details>

<details>
<summary>라이선스</summary>

AGPL-3.0 (OSS) + Commercial License.
상업적 사용 문의: dev1@moonklabs.com

</details>
