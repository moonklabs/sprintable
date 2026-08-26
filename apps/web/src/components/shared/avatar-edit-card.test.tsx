// @vitest-environment jsdom
//
// story #2887(S2g) — AvatarEditCard 클라이언트 검증(형식·용량)·삭제 플로우 회귀가드. 크롭
// 진입 후 흐름(canvas/Image decode)은 avatar-cropper 자체 스모크로 넘기고, 여기는 카드
// 레벨 로직(드롭존→검증→크롭 전환, 제거)만 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { AvatarEditCard } from './avatar-edit-card';
import koMessages from '../../../messages/ko.json';

vi.mock('@/lib/avatar-upload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/avatar-upload')>();
  return { ...actual, uploadAvatar: vi.fn(), removeAvatar: vi.fn() };
});
import { removeAvatar } from '@/lib/avatar-upload';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() });
  // AvatarCropper가 내부에서 new Image()로 로드한다 — jsdom은 실제 디코드를 안 하므로 onload를
  // 동기 발화하는 스텁으로 교체(크롭 진입 확認용, 실 렌더 픽셀은 avatar-cropper 스모크 몫 아님).
  class FakeImage {
    onload: (() => void) | null = null;
    naturalWidth = 800;
    naturalHeight = 600;
    set src(_v: string) { queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal('Image', FakeImage);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fileInput(): HTMLInputElement {
  return container.querySelector('input[type="file"]')!;
}

function setFile(file: File) {
  const input = fileInput();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('AvatarEditCard — story #2887 S2g', () => {
  it('허용되지 않는 형식이면 에러를 보이고 크롭으로 안 넘어간다', async () => {
    await act(async () => {
      root.render(wrap(<AvatarEditCard memberId="m-1" name="송윤재" avatarUrl={null} actorType="human" onUpdated={() => {}} />));
    });
    await act(async () => { setFile(new File(['x'], 'a.gif', { type: 'image/gif' })); });
    expect(container.textContent).toContain('지원하지 않는 파일 형식');
    expect(container.querySelector('input[type="range"]')).toBeNull();
  });

  it('5MB 초과 파일이면 에러를 보인다', async () => {
    await act(async () => {
      root.render(wrap(<AvatarEditCard memberId="m-1" name="송윤재" avatarUrl={null} actorType="human" onUpdated={() => {}} />));
    });
    const big = new File([new Uint8Array(6 * 1024 * 1024)], 'a.png', { type: 'image/png' });
    await act(async () => { setFile(big); });
    expect(container.textContent).toContain('5MB');
  });

  it('유효한 파일이면 크롭 UI로 전환된다', async () => {
    await act(async () => {
      root.render(wrap(<AvatarEditCard memberId="m-1" name="송윤재" avatarUrl={null} actorType="human" onUpdated={() => {}} />));
    });
    await act(async () => {
      setFile(new File(['x'], 'a.png', { type: 'image/png' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('input[type="range"]')).not.toBeNull();
  });

  it('avatar_url 없으면 제거 버튼이 안 뜬다', async () => {
    await act(async () => {
      root.render(wrap(<AvatarEditCard memberId="m-1" name="송윤재" avatarUrl={null} actorType="human" onUpdated={() => {}} />));
    });
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).not.toContain('제거');
  });

  it('제거 버튼 클릭 시 removeAvatar 호출 후 onUpdated(null)', async () => {
    vi.mocked(removeAvatar).mockResolvedValue(undefined);
    const onUpdated = vi.fn();
    await act(async () => {
      root.render(wrap(<AvatarEditCard memberId="m-1" name="송윤재" avatarUrl="https://x/a.png" actorType="human" onUpdated={onUpdated} />));
    });
    const removeBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '제거')!;
    await act(async () => { removeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(removeAvatar).toHaveBeenCalledWith('m-1');
    expect(onUpdated).toHaveBeenCalledWith(null);
  });

  it('제거 실패 시 에러 메시지를 보인다', async () => {
    vi.mocked(removeAvatar).mockRejectedValue({ code: 'FORBIDDEN', message: 'no' });
    await act(async () => {
      root.render(wrap(<AvatarEditCard memberId="m-1" name="송윤재" avatarUrl="https://x/a.png" actorType="human" onUpdated={() => {}} />));
    });
    const removeBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '제거')!;
    await act(async () => { removeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain('제거에 실패');
  });
});
