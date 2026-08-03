import { useEffect, useState } from 'react';

export default function App() {
  const [health, setHealth] = useState({
    data: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;

    async function loadHealth() {
      try {
        const response = await fetch('/health');

        if (!response.ok) {
          throw new Error(`Health check failed with ${response.status}`);
        }

        const data = await response.json();

        if (!cancelled) {
          setHealth({ data, error: null, loading: false });
        }
      } catch (error) {
        if (!cancelled) {
          setHealth({ data: null, error: error.message, loading: false });
        }
      }
    }

    loadHealth();

    return () => {
      cancelled = true;
    };
  }, []);

  const statusLabel = health.loading
    ? 'Checking'
    : health.error
      ? 'Unavailable'
      : health.data?.status;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10 text-zinc-950">
      <section className="mx-auto flex max-w-3xl flex-col gap-6">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-emerald-700">
            Distribution board monitoring
          </p>
          <h1 className="mt-3 text-3xl font-semibold">ElecSense</h1>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-zinc-500">API health</p>
              <p className="mt-1 text-xl font-semibold capitalize">
                {statusLabel}
              </p>
            </div>
            <span
              className={[
                'h-3 w-3 rounded-full',
                health.loading
                  ? 'bg-amber-400'
                  : health.error
                    ? 'bg-red-500'
                    : 'bg-emerald-500',
              ].join(' ')}
            />
          </div>

          <pre className="mt-5 overflow-auto rounded-md bg-zinc-950 p-4 text-sm text-zinc-50">
            {health.loading
              ? 'Loading /health...'
              : JSON.stringify(health.error ?? health.data, null, 2)}
          </pre>
        </div>
      </section>
    </main>
  );
}
