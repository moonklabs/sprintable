import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentWorkflowEditor } from './agent-workflow-editor';

describe('AgentWorkflowEditor', () => {
  it('renders localized Korean workflow labels instead of raw contract strings', () => {
    const markup = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <AgentWorkflowEditor
          projectName="Sprintable"
          initialMembers={[
            { id: 'agent-1', name: '디디', type: 'agent', role: '개발자' },
            { id: 'agent-2', name: '까심', type: 'agent', role: 'QA' },
          ]}
          initialRules={[
            {
              id: 'rule-1',
              org_id: 'org-1',
              project_id: 'project-1',
              agent_id: 'agent-1',
              persona_id: null,
              deployment_id: null,
              name: 'report',
              priority: 10,
              match_type: 'event',
              conditions: { memo_type: ['task', 'bug'] },
              action: { auto_reply_mode: 'process_and_report', forward_to_agent_id: null },
              target_runtime: 'openclaw',
              target_model: null,
              is_enabled: true,
              metadata: {},
              created_by: 'member-1',
              created_at: '2026-04-09T03:00:00.000Z',
              updated_at: '2026-04-09T03:00:00.000Z',
            },
          ]}
        />
      </NextIntlClientProvider>,
    );

    expect(markup).toContain('표준 개발 흐름');
    expect(markup).toContain('리뷰 중심 흐름');
    expect(markup).toContain('단독 개발 흐름');
    expect(markup).toContain('메모 유형 필터');
    expect(markup).toContain('처리 후 보고');
    expect(markup).toContain('작업, 버그');
    expect(markup).toContain('원 담당자');
    expect(markup).toContain('드라이런 시뮬레이션');
    expect(markup).toContain('예상 경로 미리보기');
    expect(markup).toContain('롤아웃 체크리스트');
    expect(markup).toContain('긴급 제어');
    expect(markup).not.toContain('>Standard Dev<');
    expect(markup).not.toContain('>Review-heavy<');
    expect(markup).not.toContain('>Solo Dev<');
    expect(markup).not.toContain('>process_and_forward<');
    expect(markup).not.toContain('>process_and_report<');
    expect(markup).not.toContain('>Original assignee<');
  });
});
