// 4924 — the ONE disabled face of the design system: a solid, dimmer face (surface-high), a solid faint border (line) and ink-3 text. It used to be a DASHED outline on a transparent face — the look of the unchosen mock «C 데이북»
// (UI-1 doc §10 «비활성(글 ink-3 · 점선)») that came along with 5508; the chosen B line's part list only says «비활성». «색만으로 비활성을 말하지 않는다» still holds: the face, the border and the text all change, and the control
// carries `disabled` / `aria-disabled` / `data-disabled` (read by screen readers). Every disabled ds part takes these constants — nothing spells its own disabled look (disabled-face.4924.test.ts pins it).
// Class names are written out whole (Tailwind finds them by scanning source text, so they cannot be built from pieces).

/** native `:disabled` — Button · IconButton(primary) · Input · Textarea · NativeSelect · DatePicker trigger */
export const DISABLED_FACE = 'disabled:border-ds-line disabled:bg-ds-surface-high disabled:text-ds-ink-3';
/** `aria-disabled` — a link/child under `Button asChild` has no native :disabled */
export const ARIA_DISABLED_FACE = 'aria-disabled:border-ds-line aria-disabled:bg-ds-surface-high aria-disabled:text-ds-ink-3';
/** Base UI roots (`data-disabled`) — Checkbox · Radio · Toggle; the CHECKED variants win over `data-checked:` so a checked-but-disabled control does not keep the action fill */
export const DATA_DISABLED_FACE = 'data-disabled:border-ds-line data-disabled:bg-ds-surface-high data-disabled:text-ds-ink-3 data-disabled:data-checked:border-ds-line data-disabled:data-checked:bg-ds-surface-high';
/** Checkbox only: the indeterminate state */
export const DATA_DISABLED_INDETERMINATE_FACE = 'data-disabled:data-indeterminate:border-ds-line data-disabled:data-indeterminate:bg-ds-surface-high';
