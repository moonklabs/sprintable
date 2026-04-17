'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

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
      setState(prev => ({ ...prev, errorCode: 'micDenied' }));
    }
  }, []);

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

  return { ...state, startRecording, stopRecording };
}
