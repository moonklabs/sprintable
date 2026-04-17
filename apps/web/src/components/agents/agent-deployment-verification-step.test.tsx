import type { AnchorHTMLAttributes, PropsWithChildren } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentDeploymentVerificationStep } from './agent-deployment-verification-step';

type MockLinkProps = PropsWithChildren<AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>;

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: MockLinkProps) => <a href={href} {...props}>{children}</a>,
}));

describe('AgentDeploymentVerificationStep', () => {
  it('renders pending verification copy instead of verified-success copy when verification is not completed yet', () => {
    const markup = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <AgentDeploymentVerificationStep
          deploymentName="Developer deployment"
          deploymentStatus="ACTIVE"
          lastDeployedAt="2026-04-12T05:30:00.000Z"
          verification={{
            status: 'pending',
            required_checkpoints: ['dashboard_active', 'routing_reviewed', 'mcp_reviewed'],
            completed_at: null,
            completed_by: null,
          }}
          verificationScopeSummary="Sprintable"
          deploymentProviderLabel="OpenAI"
          model="gpt-4o-mini"
          autoRoutingPreviewLabel="PO + Dev"
          autoRoutingRuleCount={2}
          mcpValidationErrorCount={0}
          verificationSubmitting={false}
          onCompleteVerification={() => undefined}
        />
      </NextIntlClientProvider>,
    );

    expect(markup).toContain('verification이 아직 완료되지 않은');
    expect(markup).toContain('Verification 완료로 표시');
    expect(markup).not.toContain('verification 완료까지 기록된');
  });

  it('renders completed verification confirmation once verification is persisted', () => {
    const markup = renderToStaticMarkup(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <AgentDeploymentVerificationStep
          deploymentName="Developer deployment"
          deploymentStatus="ACTIVE"
          lastDeployedAt="2026-04-12T05:30:00.000Z"
          verification={{
            status: 'completed',
            required_checkpoints: ['dashboard_active', 'routing_reviewed', 'mcp_reviewed'],
            completed_at: '2026-04-12T05:35:00.000Z',
            completed_by: 'member-1',
          }}
          verificationScopeSummary="Sprintable"
          deploymentProviderLabel="OpenAI"
          model="gpt-4o-mini"
          autoRoutingPreviewLabel="PO + Dev"
          autoRoutingRuleCount={2}
          mcpValidationErrorCount={0}
          verificationSubmitting={false}
          onCompleteVerification={() => undefined}
        />
      </NextIntlClientProvider>,
    );

    expect(markup).toContain('verification 완료까지 기록된');
    expect(markup).toContain('완료됨');
    expect(markup).not.toContain('Verification 완료로 표시');
  });
});
