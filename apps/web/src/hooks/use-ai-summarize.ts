'use client';

import { useState, useCallback, useRef } from 'react';
import { createApiClientError } from '@/lib/api-client-error';

interface AiSummarizeResult {
  summary: string;
  decisions: Array<{ id: string; text: string; owner?: string }>;
  action_items: Array<{ id: string; text: string; assignee?: string; due_date?: string; status?: string }>;
}

export function useAiSummarize(meetingId: string, fetchFn?: typeof fetch) {
  const [isLoading, setIsLoading] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AiSummarizeResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const summarize = useCallback(async (options?: { provider?: string; apiKey?: string }) => {
    setIsLoading(true);
    setStreamText('');
    setError(null);
    setResult(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await (fetchFn ?? fetch)(`/api/meetings/${meetingId}/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options ?? {}),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw await createApiClientError(res, `AI summarize failed (${res.status})`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6)) as {
                text?: string;
                done?: boolean;
                error?: string;
                summary?: string;
                decisions?: AiSummarizeResult['decisions'];
                action_items?: AiSummarizeResult['action_items'];
              };

              if (data.error) {
                setError(data.error);
                setIsLoading(false);
                return;
              }

              if (data.text) {
                setStreamText(prev => prev + data.text);
              }

              if (data.done) {
                setResult({
                  summary: data.summary ?? '',
                  decisions: data.decisions ?? [],
                  action_items: data.action_items ?? [],
                });
                setIsLoading(false);
                return;
              }
            } catch { /* skip */ }
          }
        }
      }

      setIsLoading(false);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'AI summarize failed');
      setIsLoading(false);
    }
  }, [meetingId]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setIsLoading(false);
  }, []);

  return { summarize, cancel, isLoading, streamText, error, result };
}
