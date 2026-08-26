// @vitest-environment jsdom
//
// story #3049(2984-S1) — 재질 프리미티브 5종(MaterialChip·CountBadge·VerificationStamp·
// AgentIdentity·#num) 단위 테스트. soft-fill(bg-*-soft) 대신 헤어라인/mono/엠보스/신호 dot
// 재질을 쓰는지 고정한다.
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MaterialChip } from './material-chip';
import { CountBadge } from './count-badge';
import { VerificationStamp } from './verification-stamp';
import { AgentIdentity, AgentSignalDot, AGENT_MARK_FILL_CLASS } from './agent-identity';

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

describe('MaterialChip', () => {
  it('헤어라인 border만 쓰고 soft-fill 배경은 안 쓴다', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<MaterialChip>모바일 IA</MaterialChip>); });
    const el = container.querySelector('span');
    expect(el?.textContent).toBe('모바일 IA');
    expect(el?.className).toContain('border-proof-line');
    expect(el?.className).toContain('bg-transparent');
    expect(el?.className).not.toMatch(/bg-\S+-soft/);
  });
});

describe('CountBadge', () => {
  it('mono 카운트+엠보스 inset(soft-fill 아님)을 쓴다', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<CountBadge count={38} suffix="건" />); });
    const el = container.querySelector('span');
    expect(el?.textContent).toBe('38건');
    expect(el?.className).toContain('font-mono');
    expect(el?.className).toContain('shadow-[var(--elev-inset)]');
    expect(el?.className).not.toMatch(/bg-\S+-soft/);
  });

  it('suffix 없으면 숫자만 렌더한다', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<CountBadge count={7} />); });
    expect(container.querySelector('span')?.textContent).toBe('7');
  });
});

describe('VerificationStamp', () => {
  it('success 톤은 seal이 success 색이고 soft-fill 배경은 안 쓴다', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<VerificationStamp>완료 주장</VerificationStamp>); });
    const el = container.querySelector('span');
    expect(el?.textContent).toBe('완료 주장');
    expect(el?.className).toContain('shadow-[var(--elev-inset)]');
    expect(el?.querySelector('.border-success')).toBeTruthy();
    expect(el?.className).not.toMatch(/bg-\S+-soft/);
  });

  it('neutral 톤은 seal이 무채(proof-faint)다', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<VerificationStamp tone="neutral">검토 중</VerificationStamp>); });
    expect(container.querySelector('.border-proof-faint')).toBeTruthy();
    expect(container.querySelector('.border-success')).toBeNull();
  });
});

describe('AgentIdentity', () => {
  it('헤어라인+proof-blue 신호 dot을 쓰고 soft-fill은 안 쓴다("Bot" 텍스트)', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<AgentIdentity />); });
    const el = container.querySelector('span');
    expect(el?.textContent).toBe('Bot');
    expect(el?.className).toContain('border-proof-line');
    expect(el?.className).not.toMatch(/bg-\S+-soft/);
    expect(el?.querySelector('.bg-proof-blue')).toBeTruthy();
  });

  it('AgentSignalDot 단독 렌더도 proof-blue를 쓴다(KEEP 신호)', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<AgentSignalDot />); });
    expect(container.querySelector('.bg-proof-blue')).toBeTruthy();
  });

  it('AGENT_MARK_FILL_CLASS는 배경 투명+proof-blue 텍스트만 지정한다(border는 호출부 몫)', () => {
    expect(AGENT_MARK_FILL_CLASS).toBe('bg-transparent text-proof-blue');
    expect(AGENT_MARK_FILL_CLASS).not.toMatch(/bg-\S+-soft/);
  });
});
