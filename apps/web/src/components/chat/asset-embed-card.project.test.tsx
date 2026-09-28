// @vitest-environment jsdom
//
// story #4231 4차 B(PO 07:53Z «링크에 싣는 p는 그 항목의 프로젝트») — 채팅의 자산 임베드 카드는 다른 프로젝트 자산일 수 있다 → 자산 자기
// project_id를 `?p=`로(현재 프로젝트 아님). 조직 단위 자산(project_id null)은 주소 그대로.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

const { AssetEmbedCard } = await import('./asset-embed-card');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); fetchWithAuthMock.mockReset(); });

async function render(projectId: string | null) {
  fetchWithAuthMock.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { id: 'a1', name: 'plan.pdf', content_type: 'application/pdf', size_bytes: 10, project_id: projectId } }),
  });
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <AssetEmbedCard entityId="a1" label="plan.pdf" ownMessage={false} />
    </NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return container.querySelector('a')?.getAttribute('href');
}

describe('AssetEmbedCard — 자산 자기 프로젝트(#4231 4차 B)', () => {
  it('⭐다른 프로젝트 자산 → 그 자산의 p', async () => {
    expect(await render('proj-OTHER')).toBe('/storage?asset=a1&p=proj-OTHER');
  });
  it('조직 단위 자산(project_id null) → 주소 그대로', async () => {
    expect(await render(null)).toBe('/storage?asset=a1');
  });
});
