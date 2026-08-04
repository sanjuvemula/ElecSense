import { useCallback, useEffect, useRef, useState } from 'react';

export function usePolling(fetcher, intervalMs, dependencies = []) {
  const fetcherRef = useRef(fetcher);
  const [state, setState] = useState({
    data: null,
    error: null,
    loading: true,
    updatedAt: null,
  });

  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  const refetch = useCallback(async () => {
    try {
      const data = await fetcherRef.current();

      setState({
        data,
        error: null,
        loading: false,
        updatedAt: new Date(),
      });

      return data;
    } catch (error) {
      setState((current) => ({
        ...current,
        error,
        loading: false,
      }));

      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!cancelled) {
        await refetch();
      }
    }

    load();

    const timer = window.setInterval(load, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [intervalMs, refetch, ...dependencies]);

  return {
    ...state,
    refetch,
  };
}
