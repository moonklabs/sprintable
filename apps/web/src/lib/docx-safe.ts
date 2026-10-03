// story #4532 AC5 (Kadir codex · PO 22:19Z): the .docx preview renders an uploaded document into OUR page (docx-preview, no frame
// of its own), so anything it turns into live markup runs in our origin. Two such paths in docx-preview 0.4.0, both closed here:
// - altChunk — an HTML part embedded in the document — goes into an iframe by `srcdoc` with NO sandbox (`renderAltChunks`
//   defaults to true): a srcdoc frame inherits the parent's origin, so its scripts ran as ours → off;
// - a hyperlink's external target is copied into `href` as it is (`javascript:…` included) → after rendering, a link whose
//   address is not http(s) · mailto · this page's own anchor loses its address (its text stays).
// The other defaults were read too: images go in as <img> / svg <image> (no script), style text cannot run script, comments ·
// changes are off by default, and `experimental` stays off.

/** what DocxBody passes to docx-preview's renderAsync — layout choices plus the one safety switch */
export const DOCX_RENDER_OPTIONS = {
  inWrapper: true,
  ignoreWidth: true,
  ignoreHeight: true,
  breakPages: true,
  renderAltChunks: false,
} as const;

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** After rendering: every link keeps its address only if it is http(s) · mailto · an anchor in this page; outside links open apart. */
export function neutralizeDocxLinks(root: ParentNode): void {
  root.querySelectorAll('a[href]').forEach((a) => {
    const raw = a.getAttribute('href') ?? '';
    if (raw.startsWith('#')) return; // an anchor inside the document
    let url: URL | null = null;
    try { url = new URL(raw, document.baseURI); } catch { url = null; }
    if (!url || !SAFE_LINK_PROTOCOLS.has(url.protocol)) { a.removeAttribute('href'); return; }
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
}
