// story 5043 (C10 · PO 11-28) — one `client_nonce` per DRAFT, not per call. A send that failed or whose answer was lost is pressed again by the person with the SAME words: it must carry the SAME token, so that the server
// (one message per room · sender · token) answers with the message that is already there instead of making a second copy. Other words are another send. The token is let go when the server accepted the send.
// A MAP of attempts (not one slot): callers that interleave (the composer and a card's reply button share one send) must not take each other's token away. Bounded: an attempt that never ends is forgotten after `MAX_ATTEMPTS` newer ones.
import { useCallback, useRef } from 'react';
import { newClientNonce } from '@/hooks/use-chat-sse';

const MAX_ATTEMPTS = 32;

export function useSendAttempts(): { nonceFor: (key: string) => string; accepted: (key: string) => void } {
  const attempts = useRef(new Map<string, string>());
  const nonceFor = useCallback((key: string): string => {
    const known = attempts.current.get(key);
    if (known !== undefined) return known;
    const nonce = newClientNonce();
    attempts.current.set(key, nonce);
    while (attempts.current.size > MAX_ATTEMPTS) attempts.current.delete(attempts.current.keys().next().value as string);
    return nonce;
  }, []);
  const accepted = useCallback((key: string): void => { attempts.current.delete(key); }, []);
  return { nonceFor, accepted };
}
