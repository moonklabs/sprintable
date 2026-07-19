# 근거와 출처

## 저장소 문서

- `../acceptance-bottleneck-thesis-2026-07-17.md`
  - 생산 병목이 수용 병목으로 이동했다는 핵심 테제
  - 생성은 병렬화되지만 사람 검증은 직렬이라는 구조
- `../first-principles-atoms-2026-07-17.md`
  - 의도·검증·책임·주의의 구분
  - 되돌릴 수 없는 행동에서 사람 gate가 정당해진다는 원칙
- `../integration-strategy-linear-github-2026-07-15.md`
  - `루프는 우리 것, 표면은 빌린다`
  - GitHub 깊게, Linear 얇게, headless Gate Engine + adapter 전략
- `../proof-of-done-packet-design-2026-07-12.md`
  - agent claim과 system observation 분리
  - structured reject가 agent rework prompt로 돌아가는 계약
- `../sprintable-daily-advisor-decision-report-2026-07-18.html`
  - 기능 추가, Ready Check edge runtime, 단계별 실험과 지표에 대한 상세 판단

## 외부 공식 자료

- Linear — Assign and delegate issues
  - https://linear.app/docs/assigning-issues
  - 사람 assignee가 책임을 유지한 채 agent에게 위임하는 현재 모델
- Linear — Introducing Linear Agent
  - https://linear.app/changelog/2026-03-24-introducing-linear-agent
  - workspace context, skills, automation, judgment bottleneck 방향
- GitHub — 60 million Copilot code reviews and counting
  - https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/
  - review signal, silence, linked issue, review memory의 중요성
- Claude Code — Hooks reference
  - https://code.claude.com/docs/en/hooks
  - Stop·TaskCompleted·PreToolUse 등 자동 개입 지점
- OpenAI — Codex plugin examples
  - https://github.com/openai/plugins
  - skill, MCP, hook을 묶는 공통 배포 표면
- Anthropic — The Advisor Strategy
  - https://claude.com/blog/the-advisor-strategy
  - executor와 advisor를 분리해 다른 관점의 검토를 넣는 패턴

## 수치 사용 주의

- `42% 거짓 완료`는 45개 hidden-test 과제 중 19개에서 false completion이 나온 단일 외부 실험이다. 전체 AI 작업의 일반 비율로 표현하지 않는다.
- GitHub의 `29% 무코멘트`는 GitHub Copilot code review의 공개 집계다. Sprintable의 예상 성능으로 전이하지 않고 `침묵도 품질`이라는 UX 원칙의 근거로만 사용한다.
- Anthropic Advisor의 성능·비용 개선은 Anthropic의 특정 모델 구성과 benchmark 결과다. Sprintable 효능 수치로 사용하지 않는다.
- 교육자료에 제시한 pilot 목표는 시장 benchmark가 아니라 초기 운영 임계값이다.
