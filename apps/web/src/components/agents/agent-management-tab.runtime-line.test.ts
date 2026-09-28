import { describe, expect, it } from 'vitest';
import { formatAgentRuntimeLine } from './agent-management-tab';

// story #4129 — 워크포스 1줄(«런타임 vX · (플러그인 vY) · 세션 시작 N시간 전»). 세그먼트별
// 있으면 붙고 없으면 빠진다(placeholder 없음, AC3) — 전부 없으면 줄 자체가 null(숨김).
const t = (key: string, values?: Record<string, string>) => {
  const table: Record<string, string> = {
    agentRuntimeSegment: `런타임 v${values?.version}`,
    agentRuntimePluginSegment: `(플러그인 v${values?.version})`,
    agentRuntimeSessionSegment: `세션 시작 ${values?.relative}`,
  };
  return table[key] ?? key;
};

describe('formatAgentRuntimeLine — story #4129 AC3', () => {
  it('client_version·plugin_version·session_started_at 전부 있으면 세 세그먼트를 · 로 잇는다', () => {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const line = formatAgentRuntimeLine(
      { client_version: '2.1.0', plugin_version: '0.1.4', session_started_at: fiveMinAgo },
      'ko',
      'UTC',
      t,
    );
    expect(line).toContain('런타임 v2.1.0');
    expect(line).toContain('(플러그인 v0.1.4)');
    expect(line).toContain('세션 시작');
    expect(line?.split(' · ')).toHaveLength(3);
  });

  it('plugin_version이 없으면(grok/codex 전용 헤더 미확인 등) 그 세그먼트만 빠진다', () => {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const line = formatAgentRuntimeLine(
      { client_version: '2.1.0', plugin_version: null, session_started_at: fiveMinAgo },
      'ko',
      'UTC',
      t,
    );
    expect(line).not.toContain('플러그인');
    expect(line).toContain('런타임 v2.1.0');
  });

  it('핵심 데이터(client_version·session_started_at)가 전부 없으면 줄 전체를 숨긴다(null) — placeholder로 채우지 않는다', () => {
    const line = formatAgentRuntimeLine(
      { client_version: null, plugin_version: null, session_started_at: null },
      'ko',
      'UTC',
      t,
    );
    expect(line).toBeNull();
  });

  it('client_version만 있어도(session_started_at 미확인) 그 세그먼트 하나만으로 줄을 보인다', () => {
    const line = formatAgentRuntimeLine(
      { client_version: '2.1.0', plugin_version: null, session_started_at: null },
      'ko',
      'UTC',
      t,
    );
    expect(line).toBe('런타임 v2.1.0');
  });
});
