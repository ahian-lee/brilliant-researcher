import { useEffect, useRef, useState } from 'react';
import type { Failure } from '../types';

export interface Async<T> {
  data: T | null;
  error: Failure | null;
  loading: boolean;
  lastOkAt: string | null;
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[],
  options: { resetKey?: unknown; pollMs?: number } = {},
): Async<T> {
  const [state, setState] = useState<Async<T>>({ data: null, error: null, loading: true, lastOkAt: null });
  const scope = useRef(options.resetKey);
  const fn = useRef(load);
  const inFlight = useRef<{ scope: unknown; promise: Promise<T> } | null>(null);
  fn.current = load;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reset = !Object.is(scope.current, options.resetKey);
    scope.current = options.resetKey;
    setState((prev) => ({
      data: reset ? null : prev.data,
      error: reset ? null : prev.error,
      loading: true,
      lastOkAt: reset ? null : prev.lastOkAt,
    }));
    const read = async (): Promise<void> => {
      if (!live) return;
      const previous = inFlight.current;
      const shared = options.pollMs && options.pollMs > 0 && previous && Object.is(previous.scope, options.resetKey)
        ? previous.promise : undefined;
      setState((prev) => ({ ...prev, loading: true }));
      let pending: Promise<T> | undefined;
      try {
        // A polling revision consumes the pending read; restarting it on every
        // live signal can starve slow requests. Non-polling dependency changes
        // still invoke their own loader immediately.
        pending = shared ?? fn.current();
        if (!shared) inFlight.current = { scope: options.resetKey, promise: pending };
        const data = await pending;
        if (!live) return;
        // 失败后再次成功时保留时间线：lastOkAt 始终是最近一次取到真实数据的时刻。
        setState({ data, error: null, loading: false, lastOkAt: new Date().toISOString() });
      } catch (err: unknown) {
        if (!live) return;
        setState((prev) => ({
          ...prev,
          error: { message: message(err), at: new Date().toISOString() },
          loading: false,
        }));
      } finally {
        if (inFlight.current?.promise === pending) inFlight.current = null;
        // Wait until this read settles before scheduling the next poll.
        if (live && options.pollMs && options.pollMs > 0) {
          timer = setTimeout(() => void read(), options.pollMs);
        }
      }
    };
    void read();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, options.resetKey, options.pollMs]);

  // Hide the previous project's data immediately, before the effect runs.
  if (!Object.is(scope.current, options.resetKey)) {
    return { data: null, error: null, loading: true, lastOkAt: null };
  }
  return state;
}
