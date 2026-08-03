# sprintable-connectors (작업용, 1단계)

Stage 1 — `codex` 슬라이스 하나만 담아 "레포 클론 없이 pip 설치 → 실행 → SSE 연결"이 실제로
서는지 검증하는 단계. 이름·PyPI 등록·최종 사용자 안내문은 이 단계가 선 뒤 확定한다.

## 로컬 검증

```bash
uv venv /tmp/venv-sprintable-connectors
source /tmp/venv-sprintable-connectors/bin/activate
uv pip install ./connectors/connectors-pkg   # 레포 안에서, 레포 클론 흉내

export SPRINTABLE_RUNTIME=codex
export AGENT_API_KEY=sk_live_...
export SPRINTABLE_API_URL=https://sprintable-backend-dev-57iommnikq-du.a.run.app
sprintable-connector
```

`stream open` 로그가 뜨면 SSE dial-out 성공 — repo 밖(별도 venv)에서 이 패키지만으로 붙는지가
1단계의 판정선이다.
