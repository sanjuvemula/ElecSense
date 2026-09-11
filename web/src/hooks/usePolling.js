import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Polls `fetcher` on an interval and exposes the latest successful result.
 *
 * Two ordering hazards are handled explicitly, because both are reachable on a
 * cold-starting free-tier backend where one request can take tens of seconds:
 *
 * - A response that arrives after a newer request was issued is discarded, so
 *   a slow reply cannot overwrite fresher data.
 * - A response that arrives after unmount is discarded, so no state is written
 *   to a dead component.
 *
 * Polling also pauses while the tab is hidden and resumes with an immediate
 * fetch, rather than hammering the API in a background tab.
 */
export function usePolling(fetcher, intervalMs, dependencies = []) {
  const fetcherRef = useRef(fetcher);
  const requestIdRef = useRef(0);
  const acceptedIdRef = useRef(0);
  const mountedRef = useRef(true);
  const activeControllerRef = useRef(null);
  const [state, setState] = useState({
    data: null,
    error: null,
    loading: true,
    updatedAt: null,
  });

  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      activeControllerRef.current?.abort();
    };
  }, []);

  const refetch = useCallback(async () => {
    const requestId = (requestIdRef.current += 1);
    const controller = new AbortController();

    // Only the newest request matters. Aborting the previous one frees the
    // connection instead of leaving it to finish and be thrown away, which
    // matters on a backend that can take tens of seconds to answer.
    activeControllerRef.current?.abort();
    activeControllerRef.current = controller;

    try {
      const data = await fetcherRef.current({ signal: controller.signal });

      // Drop this response if the component is gone, or if a later request has
      // already been accepted. Comparing ids rather than timestamps keeps this
      // correct even when two requests finish in the same millisecond.
      if (!mountedRef.current || requestId <= acceptedIdRef.current) {
        return null;
      }

      acceptedIdRef.current = requestId;
      activeControllerRef.current = null;
      setState({
        data,
        error: null,
        loading: false,
        updatedAt: new Date(),
      });

      return data;
    } catch (error) {
      if (
        !mountedRef.current ||
        requestId <= acceptedIdRef.current ||
        error.name === 'AbortError'
      ) {
        return null;
      }

      acceptedIdRef.current = requestId;
      setState((current) => ({
        ...current,
        error,
        loading: false,
      }));

      return null;
    }
  }, []);

  useEffect(() => {
    let timer = null;

    const isHidden = () => document.visibilityState === 'hidden';

    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      stop();

      if (isHidden()) {
        return;
      }

      void refetch();
      timer = window.setInterval(() => {
        void refetch();
      }, intervalMs);
    };

    const handleVisibilityChange = () => {
      if (isHidden()) {
        stop();
        return;
      }

      // Returning to the tab should show current data immediately, not after a
      // full interval of staleness.
      start();
    };

    start();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [intervalMs, refetch, ...dependencies]);

  return {
    ...state,
    refetch,
  };
}
