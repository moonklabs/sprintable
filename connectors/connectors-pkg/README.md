# sprintable-connectors (작업용, 1단계 완료)

"레포 클론 없이 pip 설치 → 실행 → SSE 연결"이 실제로 서는지 검증하는 1단계. 5종 전부 등록
(codex·cursor·gemini·grok·pi). 이름·PyPI 등록·최종 사용자 안내문은 아직 확定하지 않았다(배포
수단은 형태가 실측으로 선 뒤 정한다).

## 로컬 검증

```bash
uv venv /tmp/venv-sprintable-connectors
source /tmp/venv-sprintable-connectors/bin/activate
uv pip install ./connectors/connectors-pkg   # 레포 안에서, 레포 클론 흉내

export SPRINTABLE_RUNTIME=codex   # 또는 cursor / gemini / grok / pi
export AGENT_API_KEY=sk_live_...
export SPRINTABLE_API_URL=https://sprintable-backend-dev-57iommnikq-du.a.run.app
# cursor는 CURSOR_API_KEY도 필요(플레이스홀더로도 SSE 연결 자체는 확認 가능 — 실 턴 주입 시에만 쓰임)
sprintable-connector
```

`stream open` 로그가 뜨면 SSE dial-out 성공 — repo 밖(별도 venv, git repo 아닌 디렉터리)에서
이 패키지만으로 붙는지가 판정선이다. codex·cursor는 실측 완료(HTTP 200 stream open).
gemini·grok·pi는 이 저장소 개발 환경에 해당 CLI 바이너리가 없어 SSE 연결 전 단계
(subprocess spawn, `FileNotFoundError`)에서 멈춘다 — 원본 커넥터도 동일 전제이며 패키징
결함이 아님을 실패 지점으로 확認했다. 해당 CLI가 설치된 환경에서 추가 검증 필요.
