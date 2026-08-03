import { setTimeout as delay } from 'node:timers/promises';

const targetUrl =
  process.env.LOADTEST_URL ?? 'http://localhost:3000/api/telemetry';
const totalEvents = Number(process.env.LOADTEST_TOTAL ?? 5000);
const durationMs = Number(process.env.LOADTEST_DURATION_MS ?? 10_000);
const batchSize = Number(process.env.LOADTEST_BATCH_SIZE ?? 50);
const requestCount = Math.ceil(totalEvents / batchSize);
const intervalMs = durationMs / requestCount;
const latencies = [];
const startedAt = Date.now();
let sentEvents = 0;
let acceptedEvents = 0;
let failedRequests = 0;

await Promise.all(
  Array.from({ length: requestCount }, async (_, requestIndex) => {
    await delay(Math.round(requestIndex * intervalMs));

    const remaining = totalEvents - sentEvents;
    const currentBatchSize = Math.min(batchSize, remaining);
    const batch = Array.from({ length: currentBatchSize }, (_, eventIndex) =>
      createEvent(sentEvents + eventIndex),
    );
    sentEvents += currentBatchSize;

    const requestStartedAt = Date.now();

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch.length === 1 ? batch[0] : batch),
      });
      const latency = Date.now() - requestStartedAt;

      latencies.push(latency);

      if (!response.ok) {
        failedRequests += 1;
        return;
      }

      const body = await response.json();
      acceptedEvents += body.stored ?? 0;
    } catch {
      failedRequests += 1;
    }
  }),
);

const finishedAt = Date.now();
const sortedLatencies = latencies.toSorted((left, right) => left - right);
const elapsedSeconds = (finishedAt - startedAt) / 1000;

console.log(
  JSON.stringify(
    {
      targetUrl,
      sentEvents,
      storedEventsAcknowledged: acceptedEvents,
      failedRequests,
      elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
      throughputEventsPerSecond: Number(
        (sentEvents / elapsedSeconds).toFixed(2),
      ),
      latencyMs: {
        p50: percentile(sortedLatencies, 50),
        p90: percentile(sortedLatencies, 90),
        p95: percentile(sortedLatencies, 95),
        p99: percentile(sortedLatencies, 99),
        max: sortedLatencies.at(-1) ?? 0,
      },
    },
    null,
    2,
  ),
);

function createEvent(index) {
  const deviceNumber = (index % 250) + 1;
  const poleNumber = 24_431 + (index % 3000);
  const seq = Math.floor(Date.now() / 1000) * 10_000 + index;
  const event = index % 20 === 0 ? 'power_lost' : 'heartbeat';
  const energized = event !== 'power_lost';

  return {
    device_id: `KSPDB-SD07-DT-001-${String(deviceNumber).padStart(4, '0')}`,
    pole_id: `P-${String(poleNumber).padStart(6, '0')}`,
    event,
    energized,
    ts: new Date().toISOString(),
    seq,
    battery_mv: 3700 + (index % 350),
    rssi: -60 - (index % 40),
    fw: index % 12 === 0 ? '1.2.x' : '1.4.2',
  };
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return 0;
  }

  const index = Math.ceil((percentileValue / 100) * values.length) - 1;

  return values[Math.max(0, Math.min(values.length - 1, index))];
}
