# sprintable-connectors

Sprintable Gateway 에이전트 커넥터(codex·cursor·gemini·grok·pi) — **레포 클론 없이** 설치·실행.

기존 `connectors/*-sprintable/README.md`들은 설치 첫 줄이 `git pull origin develop`이라 BYOA
SaaS 사용자(우리 레포를 clone할 이유가 없는 사람)를 온보딩 완료화면에서 막았다. 이 패키지가
그 경계를 없앤다 — 필요한 건 wheel 하나(추후 PyPI 배포)뿐이다.

## 설치 — 레포 없이

> ⚠️ **PyPI publish는 아직 안 했다**(이름 등록은 되돌릴 수 없어 확認 대기 중). 배포 전 검증은
> 아래 "로컬/QA 검증"으로 한다 — 이때도 **레포 clone은 필요 없다**, wheel 파일 하나면 된다.

배포 후(예정):
```bash
pip install sprintable-connectors      # 또는: uvx --from sprintable-connectors sprintable-connector
```

## 실행

```bash
export SPRINTABLE_RUNTIME=codex        # codex | cursor | gemini | grok | pi 중 하나 — 필수
export AGENT_API_KEY=sk_live_...       # Sprintable agent API key — 필수
export SPRINTABLE_API_URL=https://...  # 미설정 시 dev 백엔드 기본값
# 런타임별 추가 요구사항(해당 CLI/서비스는 BYOA 사용자가 이미 보유):
#   codex   → codex CLI 설치(`codex --version`), 선택 CODEX_BIN
#   gemini  → gemini-cli 설치(`gemini --version`), 선택 GEMINI_BIN
#   grok    → Grok Build CLI 설치(`grok --version`), 선택 GROK_BIN
#   pi      → pi CLI 설치(`pi --version`), 선택 PI_BIN
#   cursor  → CURSOR_API_KEY(Cursor 클라우드), 선택 CURSOR_REPO_URL/CURSOR_API_BASE

sprintable-connector
```

`SPRINTABLE_RUNTIME`은 auto-detect하지 않는다 — 명시 선택만 받는다. 값을 비우거나 오타(예:
`codx`)를 내면 즉시 에러로 종료한다(조용히 기본값으로 넘어가지 않음, 실측 확認됨):

```
$ SPRINTABLE_RUNTIME=codx sprintable-connector
Error: unknown SPRINTABLE_RUNTIME='codx'.
  Available: codex, cursor, gemini, grok, pi
```

## 로컬/QA 검증 (레포 clone 없이, wheel만으로)

```bash
uv build ./connectors/connectors-pkg              # wheel 산출(개발자 쪽, 1회)
# --- 아래부터는 wheel 파일 하나만 있으면 되는 부분(QA/최종 사용자 재현 경로) ---
uv venv /tmp/venv-sprintable-connectors
uv pip install --python /tmp/venv-sprintable-connectors/bin/python \
    /path/to/sprintable_connectors-*.whl
cd /tmp/some/empty/dir                            # git repo 아닌 곳 — 판정선
export SPRINTABLE_RUNTIME=codex AGENT_API_KEY=sk_live_... SPRINTABLE_API_URL=https://...
/tmp/venv-sprintable-connectors/bin/sprintable-connector
```

`stream open`(HTTP 200) 로그가 뜨면 성공. `codex`·`cursor`는 이 절차로 실측 완료(`cursor`는
`CURSOR_API_KEY`에 아무 non-empty 값이나 있으면 됨 — 그 값이 비어 있으면 `main()`이
`SprintableSSEClient`를 만들기 *전에* 조기 종료한다(`cursor.py` L203-204). 실제 검증엔
**플레이스홀더**를 썼다 — Sprintable 게이트웨이 SSE 연결은 진짜지만, 그 키로 실제 turn을
주입하면 Cursor Cloud API(`api.cursor.com`)가 401을 낸다 — 그 라운드트립은 별도 검증 필요).
`gemini`·`grok`·`pi`는 해당 CLI가 설치된 환경에서 마저 확認 필요(이 개발 환경엔 그 CLI들이 없어
`FileNotFoundError`로 멈춘다 — `ImportError`가 아니므로 패키징 결함이 아니라 CLI 부재임을
구별할 수 있다. 원본 커넥터 README도 동일 전제).

## 구조

- `sprintable_connectors/sdk.py` — SSE 소비·dedup·ack·backoff 공통부(정본, vendor 복제 없음)
- `sprintable_connectors/{codex,cursor,gemini,grok,pi}.py` — 런타임별 injection(프로토콜 로직은
  각 원본 커넥터와 byte-identical, 유일한 차이는 SDK를 패키지 상대 import로 받는 것뿐)
- `sprintable_connectors/__main__.py` — `SPRINTABLE_RUNTIME` 기반 진입점 선택
