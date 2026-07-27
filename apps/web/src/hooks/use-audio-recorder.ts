'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRenderNonce } from './use-render-nonce';

/** Error codes for i18n mapping in the component layer */
export type RecorderErrorCode = 'micDenied' | 'recordingFailed';

export interface AudioRecorderState {
  isRecording: boolean;
  duration: number;
  audioBlob: Blob | null;
  audioUrl: string | null;
  errorCode: RecorderErrorCode | null;
  analyser: AnalyserNode | null;
}

export function useAudioRecorder() {
  const [state, setState] = useState<AudioRecorderState>({
    isRecording: false, duration: 0, audioBlob: null, audioUrl: null, errorCode: null, analyser: null,
  });
  // story #2154 — getUserMedia 실패 분기가 errorCode를 직접 세팅하며 null 리셋을 거치지
  // 않는다(#2400이 남긴 latent gap). 연속 동일 실패 시 재낭독이 안 될 수 있던 것을
  // nonce-key로 구조적으로 막는다 — 소비 측이 key={errorNonce}로 쓴다.
  const [errorNonce, bumpErrorNonce] = useRenderNonce();

  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTime = useRef(0);
  const audioCtx = useRef<AudioContext | null>(null);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // 파형 분석용
      audioCtx.current = new AudioContext();
      const source = audioCtx.current.createMediaStreamSource(stream);
      const analyser = audioCtx.current.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/wav',
      });
      chunks.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunks.current, { type: recorder.mimeType });
        const url = URL.createObjectURL(blob);
        setState(prev => ({ ...prev, isRecording: false, audioBlob: blob, audioUrl: url, analyser: null }));
        stream.getTracks().forEach(t => t.stop());
        audioCtx.current?.close();
      };
      recorder.onerror = () => {
        bumpErrorNonce();
        setState(prev => ({ ...prev, isRecording: false, errorCode: 'recordingFailed', analyser: null }));
        stream.getTracks().forEach(t => t.stop());
        audioCtx.current?.close();
      };

      recorder.start(1000);
      mediaRecorder.current = recorder;
      startTime.current = Date.now();

      timerRef.current = setInterval(() => {
        setState(prev => ({ ...prev, duration: Math.floor((Date.now() - startTime.current) / 1000) }));
      }, 1000);

      setState({ isRecording: true, duration: 0, audioBlob: null, audioUrl: null, errorCode: null, analyser });
    } catch {
      bumpErrorNonce();
      setState(prev => ({ ...prev, errorCode: 'micDenied' }));
    }
  }, [bumpErrorNonce]);

  const stopRecording = useCallback(() => {
    if (mediaRecorder.current?.state === 'recording') {
      mediaRecorder.current.stop();
    }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorder.current?.state === 'recording') mediaRecorder.current.stop();
      audioCtx.current?.close();
    };
  }, []);

  return { ...state, errorNonce, startRecording, stopRecording };
}
