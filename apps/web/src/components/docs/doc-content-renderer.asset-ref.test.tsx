// @vitest-environment jsdom
//
// S4 docs-attach regression guard — read-only renderer (doc-content-renderer.tsx) MUST
// resolve Storage asset-ref attachments when authed, and MUST stay inert (no signed
// fetch) in public mode. This permanently locks two merge-blockers:
//   1) asset-ref docs rendering BLANK/inert in the doc VIEW surface (authed), and
//   2) the 401-leak boundary (public share never calls the signed route).
// It also guards legacy base64 (data-url) docs from regressing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DocContentRenderer } from './doc-content-renderer';

// next/image → plain <img> (keeps the markdown legacy-image assertion DOM-simple).
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src?: string; alt?: string }) =>
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} data-next-image="true" />,
}));

const SIGNED_URL = 'https://signed.example/asset.png?sig=abc';

// asset-ref markup (LOCKED): image = data-asset-id + meta, NO src · file = data-asset-id, NO data-file-data.
const ASSET_REF_HTML =
  '<img data-asset-id="img-1" data-filename="shot.png" data-size="2048" data-mime-type="image/png" alt="screenshot">' +
  '<div data-type="fileAttachment" data-filename="report.pdf" data-size="4096" data-mime-type="application/pdf" data-asset-id="file-1"></div>';

// legacy markup: image src=data: · file data-file-data=data: (no data-asset-id).
const LEGACY_HTML =
  '<img src="data:image/png;base64,AAAA" alt="legacy">' +
  '<div data-type="fileAttachment" data-filename="old.pdf" data-size="10" data-mime-type="application/pdf" data-file-data="data:application/pdf;base64,BBBB"></div>';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let openMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { url: SIGNED_URL } }),
  })) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal('fetch', fetchMock);
  openMock = vi.fn();
  vi.stubGlobal('open', openMock);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount(node: React.ReactElement) {
  await act(async () => { root.render(node); });
  // flush the effect's post-await microtask chain (signed fetch → json → DOM mutation).
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('DocContentRenderer · asset-ref (S4 docs-attach regression)', () => {
  it('authed (html): resolves the asset-ref image src + makes the asset-ref file clickable (not inert/blank)', async () => {
    await mount(<DocContentRenderer content={ASSET_REF_HTML} contentFormat="html" />);

    // image: signed route hit → img.src set to the signed URL (was blank before the fix).
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/attachments/sign?asset_id=img-1'));
    const img = container.querySelector<HTMLImageElement>('img[data-asset-id="img-1"]');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(SIGNED_URL);

    // file: NOT the inert public placeholder — it carries an interactive (cursor-pointer) card.
    const fileBlock = container.querySelector<HTMLElement>('[data-type="fileAttachment"]');
    expect(fileBlock).not.toBeNull();
    expect(fileBlock?.innerHTML).toContain('cursor-pointer');

    // clicking the ref file resolves via the signed route with attachment disposition → new tab.
    await act(async () => {
      fileBlock?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/attachments/sign?asset_id=file-1&disposition=attachment'));
    expect(openMock).toHaveBeenCalledWith(SIGNED_URL, '_blank', 'noopener,noreferrer');
  });

  it('public (html): keeps inert placeholders and NEVER calls the signed route (401-leak boundary)', async () => {
    await mount(
      <DocContentRenderer
        content={ASSET_REF_HTML}
        contentFormat="html"
        publicMode
        publicAttachmentLabel="Attachment unavailable in public view"
        publicImageLabel="Image unavailable in public view"
      />,
    );

    // hard security assertion: no signed fetch whatsoever in public mode.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();

    // the asset-ref <img> is swapped for an inert placeholder div (no live <img> at all,
    // no signed src) — the placeholder reuses alt text ("screenshot") when present.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('img[data-asset-id]')).toBeNull();
    expect(container.textContent).toContain('screenshot');
    // the asset-ref file shows its inert (opacity-70) placeholder, not the interactive card.
    const fileBlock = container.querySelector<HTMLElement>('[data-type="fileAttachment"]');
    expect(fileBlock?.innerHTML).toContain('opacity-70');
    expect(fileBlock?.innerHTML).toContain('Attachment unavailable in public view');
    expect(fileBlock?.innerHTML).not.toContain('cursor-pointer');
  });

  it('authed (html): legacy base64 image + file render directly and unchanged (regression 0)', async () => {
    await mount(<DocContentRenderer content={LEGACY_HTML} contentFormat="html" />);

    // legacy image keeps its data: src untouched (no signed resolution).
    const img = container.querySelector<HTMLImageElement>('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    // no signed fetch for legacy content on initial render.
    expect(fetchMock).not.toHaveBeenCalled();

    // legacy file → interactive card; clicking triggers the blob download (no signed fetch).
    const fileBlock = container.querySelector<HTMLElement>('[data-type="fileAttachment"]');
    expect(fileBlock?.innerHTML).toContain('cursor-pointer');
    await act(async () => {
      fileBlock?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('authed (markdown): asset-ref <img> survives sanitize + resolves via the signed route', async () => {
    // raw asset-ref <img> embedded in a markdown doc — guards the rehype-sanitize schema
    // extension (default schema strips img data-* → would render blank without the fix).
    const md = 'Intro\n\n<img data-asset-id="md-1" data-filename="m.png" data-size="5" data-mime-type="image/png" alt="md shot">\n\nOutro';
    await mount(<DocContentRenderer content={md} contentFormat="markdown" />);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/attachments/sign?asset_id=md-1'));
    const img = container.querySelector<HTMLImageElement>('img');
    expect(img?.getAttribute('src')).toBe(SIGNED_URL);
    // it is the resolver-rendered <img>, NOT a blank NextImage (mock tags those data-next-image).
    expect(img?.getAttribute('data-next-image')).toBeNull();
  });

  it('authed (markdown): asset-ref file div survives sanitize + becomes clickable (guards the div data-* schema)', async () => {
    // raw asset-ref fileAttachment <div> in a markdown doc — the default rehype-sanitize schema
    // strips div data-type/data-asset-id, so the resolver (querySelectorAll[data-type]) would miss
    // it → inert. The docMarkdownSanitizeSchema div extension keeps it resolvable.
    const md = 'Intro\n\n<div data-type="fileAttachment" data-filename="r.pdf" data-size="9" data-mime-type="application/pdf" data-asset-id="mdfile-1"></div>\n\nOutro';
    await mount(<DocContentRenderer content={md} contentFormat="markdown" />);

    const fileBlock = container.querySelector<HTMLElement>('[data-type="fileAttachment"]');
    expect(fileBlock).not.toBeNull();
    expect(fileBlock?.innerHTML).toContain('cursor-pointer');
    await act(async () => {
      fileBlock?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/attachments/sign?asset_id=mdfile-1&disposition=attachment'));
    expect(openMock).toHaveBeenCalledWith(SIGNED_URL, '_blank', 'noopener,noreferrer');
  });

  it('public (markdown): asset-ref image never triggers the signed route', async () => {
    const md = 'Intro\n\n<img data-asset-id="md-2" data-filename="m.png" data-size="5" data-mime-type="image/png" alt="md shot">';
    await mount(
      <DocContentRenderer content={md} contentFormat="markdown" publicMode publicImageLabel="Image unavailable in public view" />,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
