import { LAYER } from '../src/components/ds/layers';

/**
 * 4906 — the three fill variants of the bubble text box in chat-bubble.tsx (`isMine ? `…` : isAgent ? `…` : `…``), read from the SOURCE text for the browser specs that measure the component's own class strings.
 * The fills come from the layer map (`${LAYER.rowMine}` …): they are resolved here from components/ds/layers.ts so the spec compiles the real class names. One parser for every spec — a change of the bubble's source shape breaks one place.
 */
export function bubbleVariants(src: string): { mine: string; agent: string; person: string } | null {
  const m = /isMine\s*\?\s*`([^`]+)`\s*:\s*isAgent\s*\?\s*`([^`]+)`\s*:\s*`([^`]+)`\s*\}`\}\s*data-bubble=/.exec(src);
  if (!m) return null;
  const resolve = (t: string) => t.replace(/\$\{LAYER\.(\w+)\}/g, (_x, k: string) => LAYER[k as keyof typeof LAYER]).trim();
  return { mine: resolve(m[1]!), agent: resolve(m[2]!), person: resolve(m[3]!) };
}
