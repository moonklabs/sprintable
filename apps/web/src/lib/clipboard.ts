/**
 * story #3986(클래스 «거짓 성공 표시») — `navigator.clipboard.writeText`를
 * `try { await ... } catch {}` 뒤 무조건 「복사됨」을 보이던 자리가 develop에
 * 14파일·17곳 있었다(권한 거부·비보안 컨텍스트·포커스 없음이면 실제로는 안
 * 복사됐는데 복사됐다고 말하는 화면). `agent-api-key-manager.tsx`의
 * `writeToClipboard`(이미 execCommand 폴백+실패 시 throw까지 갖춘 선례)를
 * 그대로 일반화 — 새 판단 로직 발명 0, 있던 걸 공용화만 한다.
 *
 * 호출부는 `try/catch` 대신 `{ ok }`만 보고 분기한다(성공 표시는 ok일 때만).
 */
async function writeToClipboardOrFallback(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // 비보안 컨텍스트·구형 브라우저 폴백(agent-api-key-manager.tsx 선례 그대로).
  const prev = document.activeElement as HTMLElement | null;
  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', '');
  el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px';
  document.body.appendChild(el);
  el.focus();
  el.select();
  el.setSelectionRange(0, el.value.length);
  const ok = document.execCommand('copy');
  document.body.removeChild(el);
  prev?.focus();
  if (!ok) throw new Error('execCommand copy failed');
}

export type CopyResult = { ok: true } | { ok: false };

/** writeText가 실제로 끝났을 때만 { ok: true } — 실패는 삼키지 않고 { ok: false }. */
export async function copyTextSafely(text: string): Promise<CopyResult> {
  try {
    await writeToClipboardOrFallback(text);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}


/**
 * story 4766 — copy text that is not ready yet. The press that makes the agent and its key awaits several answers before the line exists, and
 * a browser that wants a recent user gesture for the clipboard (Safari · Chrome after a few seconds) would refuse a `writeText` made then. A
 * `ClipboardItem` takes the text as a PROMISE, so the write starts inside the click and the browser waits for the text. Without that API the
 * text is awaited and the ordinary path is used. Failure (the promise rejected, the permission refused) is `{ ok: false }`, never swallowed.
 */
export async function copyPromisedText(text: Promise<string>): Promise<CopyResult> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const blob = text.then((t) => new Blob([t], { type: 'text/plain' }));
      blob.catch(() => undefined); // the derived promise is the browser's to settle; if the write call already failed, nobody else reads this rejection
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return { ok: true };
    }
    return await copyTextSafely(await text);
  } catch {
    return { ok: false };
  }
}
