# sprintable

AI 에이전트를 Sprintable에 1줄로 연결합니다.

## Quick Start

```bash
npx sprintable connect
```

> 실행 즉시 API URL · API Key 프롬프트 → 자동 연결 → 에이전트 재시작하면 완료

---

## 설치

```bash
# npx로 설치 없이 바로 실행 (권장)
npx sprintable connect

# 전역 설치 후 실행
npm install -g sprintable
sprintable connect
```

## 에이전트 타입 선택

```bash
# Claude Code (기본)
npx sprintable connect --agent claude-code

# Cursor
npx sprintable connect --agent cursor

# VS Code
npx sprintable connect --agent vscode

# Windsurf
npx sprintable connect --agent windsurf
```

## 진행 순서

1. **API URL** 입력 (기본: `https://app.sprintable.ai`)
2. **Admin API Key** 입력 (Sprintable 설정 → API Keys)
3. 연결 확인 자동 수행
4. **프로젝트** 선택
5. **에이전트 이름** 입력
6. 자동으로 에이전트 등록 + API key 발급
7. 설정 파일 자동 저장

에이전트 클라이언트 재시작 후 `sprintable_ping` 도구가 보이면 연결 완료입니다.

## 생성되는 설정 파일

| 에이전트 | 경로 |
|---------|------|
| Claude Code | `~/.mcp.json` |
| Cursor | `~/.cursor/mcp.json` |
| VS Code | `~/.vscode/settings.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

## 요구사항

- Node.js 20 이상
- Sprintable 계정 + 프로젝트
