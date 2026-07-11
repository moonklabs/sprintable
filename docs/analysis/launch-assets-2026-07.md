# Launch 자산 초안 (2026-07, star 1000 GTM)

근거: `gtm-1000-stars-2026-07.md` §1.5/§1.7. 앵글은 Week 1 X/GeekNews 선테스트 후 확정.

## Show HN 앵글 1 (주력) — done 판정·merge gate

**제목**: Show HN: Sprintable – Tickets and merge gates for coding agents

**본문 초안**:

> Hey HN! Spinning up parallel coding agents is easy now — Claude Code, Codex and Cursor all do it natively. What I couldn't solve with any of them: knowing when an agent's work is actually *done* and *safe to merge*. One agent quietly undoes another's change, tests pass locally but the merge breaks a sibling branch, and I end up re-reviewing everything anyway.
>
> Sprintable is a self-hostable server that sits above your agents. Each agent gets a ticket with acceptance criteria and its own scoped permissions. When it claims "done", the work hits a human gate — approve, hold, or reject — before anything merges. Every handoff, message and decision lands in one auditable ledger, so any agent (or you) can reconstruct full context later.
>
> It's vendor-neutral: agents connect over MCP (98 tools) or A2A, receive work over SSE — Claude Code writing while Codex reviews works out of the box.

<!-- tool 수는 발사 직전 `_TOOL_DEFS` 실측으로 갱신할 것 (7/11 실측 98, 계속 증가 중) -->
>
> `git clone && docker compose up -d` — running in about a minute. AGPL-3.0.
>
> I'd love feedback, especially from anyone running 3+ agents in parallel: what does your "is it actually done?" check look like today?

- 데모: real project에서 dev agent가 done 선언 → gate에서 diff 확인 → reject → agent가 수정 → approve → merge. 토큰 비용 표시 화면 포함.
- 예상 반론 대응: "harness가 이미 함" → harness는 spawn/병렬은 하지만 done 판정·merge gate·cross-vendor 원장은 없음. "토큰 낭비" → gate는 LLM 호출이 아니라 상태 기계임.

## Show HN 앵글 2 — cross-vendor 상호 리뷰

**제목**: Show HN: Claude Code writes, Codex reviews – one neutral ledger with human merge gates

**본문 초안**:

> A pattern I kept seeing (and using): Claude Code is faster at writing code, but I trust Codex more for review. Every tool wants to be the whole team, but the trust is asymmetric per vendor.
>
> Sprintable is a neutral coordination server above both. The dev agent and the review agent are separate team members with their own identity, permissions and inbox. Work moves between them as tickets over SSE, the review verdict lands in the thread, and a human merge gate has the final word. Everything is one auditable ledger — MCP + A2A, self-hosted, AGPL.

## Reddit r/ClaudeCode 포스트 (1인칭 서사 포맷)

**제목**: The hard part of parallel agents was never spawning them — it's knowing when work is done and safe to merge. So I built a gate server.

- 6/23 스레드("reconciliation and stop") 톤과 연결, 광고 아닌 경험담 → 마지막에 repo 링크.
- 규칙 확인: r/ClaudeCode 셀프 프로모션 규정 확인 후 게시 (모더레이션 봇 있음).

## X 선테스트 (Week 1, 앵글 A/B)

- Tweet A: "Spinning up 5 coding agents is easy. Knowing which of them actually finished — and whose diff is safe to merge — is the whole job now. Built a self-hosted gate server for that: tickets, merge gates, audit ledger. MCP+A2A." + gate 데모 15초 클립
- Tweet B: "Claude Code writes. Codex reviews. One ledger coordinates both, a human gate merges." + 스크린샷
- 판정: 48시간 임프레션/북마크 비교 → 높은 쪽을 Show HN 앵글로.

## GeekNews (한국)

**제목**: 코딩 에이전트 병렬 실행의 진짜 문제는 '완료 판정'입니다 — 셀프호스트 게이트 서버 Sprintable

- 본문: vibe-kanban 셧다운 이후 공백 + done 판정/merge gate 문제 정의 + docker 원커맨드. 한국어 README 링크.

## 체크리스트 (발사 전)

- [ ] TTHW 실측 <5분 (Task #1 결과로 확정)
- [x] README 새 앵글 반영 (Task #2) — 7/11 확인: 영/한 모두 delivery ledger 포지션 반영 완료
- [ ] repo description 교체 (여전히 "AI-powered sprint management (MCP + SQLite + single-user)")
- [ ] llms.txt / llms-full.txt tool 수 정정 ("89 tools" → 실측치)
- [ ] gate 승인/차단 데모 GIF 또는 15초 클립
- [ ] 토큰 비용 가시성 화면
- [ ] r/ClaudeCode·r/ClaudeAI 셀프프로모션 규정 확인
- [ ] HN 계정 상태 확인 (신규 계정 불리 — 기존 계정 사용)
- [ ] 발사일: 7/17(금 회피, 화·수 오전 PT)
