import { useEffect, useRef, useState } from 'react';

export type LiveMode = 'connecting' | 'sse' | 'poll';

const STREAM_EVENTS = ['run', 'change', 'host', 'collector_error', 'host_error'];
const POLL_MS = 5_000;
const COALESCE_MS = 300;
const OPEN_TIMEOUT_MS = 6_000;

export const LIVE_NOTE: Record<LiveMode, string> = {
  connecting: '正在连接实时推送',
  sse: '实时推送已连接',
  poll: '实时推送不可用，按 5 秒轮询',
};

export function useLive(onSignal: () => void): { mode: LiveMode; note: string } {
  const [mode, setMode] = useState<LiveMode>('connecting');
  const cb = useRef(onSignal);
  cb.current = onSignal;

  useEffect(() => {
    let poll: number | null = null;
    let debounce: number | null = null;
    let openTimer: number | null = null;

    const fire = (): void => {
      if (debounce !== null) return;
      debounce = window.setTimeout(() => {
        debounce = null;
        cb.current();
      }, COALESCE_MS);
    };
    const startPoll = (): void => {
      if (poll !== null) return;
      setMode('poll');
      poll = window.setInterval(fire, POLL_MS);
    };
    const stopPoll = (): void => {
      if (poll !== null) {
        window.clearInterval(poll);
        poll = null;
      }
      setMode('sse');
    };

    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/stream?since=0');
      es.onopen = () => {
        if (openTimer !== null) window.clearTimeout(openTimer);
        stopPoll();
      };
      es.onerror = () => startPoll();
      for (const name of STREAM_EVENTS) es.addEventListener(name, fire);
      es.addEventListener('message', fire);
      openTimer = window.setTimeout(startPoll, OPEN_TIMEOUT_MS);
    } catch {
      startPoll();
    }

    return () => {
      if (openTimer !== null) window.clearTimeout(openTimer);
      if (poll !== null) window.clearInterval(poll);
      if (debounce !== null) window.clearTimeout(debounce);
      if (es) {
        es.onopen = null;
        es.onerror = null;
        es.close();
      }
    };
  }, []);

  return { mode, note: LIVE_NOTE[mode] };
}
