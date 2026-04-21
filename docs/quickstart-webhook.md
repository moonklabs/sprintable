# GitHub Webhook 연동 가이드

GitHub PR 머지 → Sprintable 티켓 자동 종료 설정 가이드.

---

## 사전 확인

- Sprintable이 실행 중이어야 합니다 (`docker compose -f docker-compose.oss.yml up`)
- GitHub 저장소의 Settings 접근 권한 필요 (Owner 또는 Admin)

---

## Step 1: Webhook URL 결정

| 환경 | Webhook URL |
|---|---|
| 로컬 개발 | ngrok 사용 필요 (아래 참고) |
| Docker (동일 네트워크) | `http://host.docker.internal:3108/api/webhooks/github` |
| 외부 서버 | `https://your-domain.com/api/webhooks/github` |

### 로컬 개발: ngrok 설정

GitHub은 공인 IP/도메인에서만 webhook을 전송합니다. 로컬 개발 시 ngrok으로 터널을 열어야 합니다:

```bash
# ngrok 설치 후
ngrok http 3108
# 출력 예: https://abc123.ngrok-free.app → localhost:3108
```

Webhook URL: `https://abc123.ngrok-free.app/api/webhooks/github`

---

## Step 2: Secret 생성

```bash
# 랜덤 secret 생성
openssl rand -hex 32
# 예: a3f8e2c1d4b5...

# .env 파일에 추가
echo "GITHUB_WEBHOOK_SECRET=<위에서 생성한 값>" >> .env

# 컨테이너 재시작 (env 변경 적용)
docker compose -f docker-compose.oss.yml restart
```

---

## Step 3: GitHub Webhook 등록

1. GitHub 저장소 → **Settings** 탭
2. 왼쪽 사이드바 → **Webhooks**
3. **Add webhook** 버튼 클릭

설정값 입력:

| 항목 | 값 |
|---|---|
| **Payload URL** | Step 1에서 결정한 URL |
| **Content type** | `application/json` ← 반드시 변경 |
| **Secret** | Step 2에서 생성한 값 |
| **SSL verification** | Enable (HTTPS 사용 시) |
| **Which events?** | "Let me select individual events" 선택 |

이벤트 선택: **Pull requests** 체크박스만 선택 (다른 이벤트 불필요)

**Add webhook** 클릭으로 저장.

---

## Step 4: 연동 확인

### 방법 1: GitHub 대시보드

Webhook 저장 직후 GitHub이 ping 이벤트를 전송합니다.
Webhook 설정 페이지의 **Recent Deliveries** 탭에서 녹색 체크(✓)가 표시되면 성공.

### 방법 2: curl로 엔드포인트 확인

```bash
# 서명 없이 전송 → 400 반환이 정상 (서버가 살아있다는 증거)
curl -X POST http://localhost:3108/api/webhooks/github \
  -H "Content-Type: application/json" \
  -d '{}' \
  -w "\nHTTP %{http_code}\n"
# 예상: HTTP 400
```

### 방법 3: 실제 PR 테스트

PR 제목에 티켓 ID 포함 후 머지:

```
feat: 로그인 페이지 구현 [SPR-1]
```

또는 PR 본문에:

```
closes SPR-1
```

Sprintable 보드에서 해당 스토리가 "Done" 컬럼으로 이동하는지 확인.

---

## 트러블슈팅

### webhook이 GitHub에서 보내졌는데 Sprintable에서 반응 없음

**원인 1: 로컬 URL 사용 중**
- GitHub → 공인 인터넷 → localhost (접근 불가)
- 해결: ngrok 사용 또는 외부 서버 배포

**원인 2: 포트 포워딩/방화벽**
```bash
# 외부 서버에서 포트 열려있는지 확인
curl http://your-server:3108/api/health
```

**원인 3: Secret 불일치**
```bash
# 컨테이너 로그 확인
docker compose -f docker-compose.oss.yml logs web | grep github-webhook
# "Invalid signature" 메시지가 있으면 secret 불일치
```

### connection refused

```bash
# Docker 실행 중인지 확인
docker ps | grep sprintable

# 재시작
docker compose -f docker-compose.oss.yml restart
```

### PR 머지 후 스토리가 닫히지 않음

PR 제목/본문에 아래 패턴 중 하나가 있는지 확인:
- `SPR-123` (대소문자 무관)
- `closes SPR-123`
- `fixes SPR-123`

스토리 제목에도 해당 ID가 포함되어야 합니다.

---

## 다음 단계

연동 완료 후:
- [Claude Code MCP 통합](../README.ko.md#고급-기능-첫-성공-후) — AI로 스토리 생성/수정
- [Self-hosting 상세 가이드](./self-hosting.md) — 프로덕션 배포
