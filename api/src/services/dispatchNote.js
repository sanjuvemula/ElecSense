import { createHash } from 'node:crypto';

export const DISPATCH_NOTE_SOURCES = Object.freeze({
  LLM: 'llm',
  TEMPLATE_FALLBACK: 'template-fallback',
});

export const DEFAULT_DISPATCH_NOTE_TIMEOUT_MS = 5000;
export const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-haiku-latest';
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

export function shouldReuseDispatchNote(incident, fingerprint, regenerate) {
  return (
    regenerate !== true &&
    Boolean(incident.dispatchNote) &&
    incident.dispatchNoteFingerprint === fingerprint
  );
}

export async function generateDispatchNote(incident, options = {}) {
  const fingerprint = buildDispatchNoteFingerprint(incident);

  if (shouldReuseDispatchNote(incident, fingerprint, options.regenerate)) {
    return {
      note: incident.dispatchNote,
      source: incident.dispatchNoteSource,
      fingerprint,
      reused: true,
    };
  }

  try {
    const note = await callAnthropicForDispatchNote(incident, options);

    return {
      note,
      source: DISPATCH_NOTE_SOURCES.LLM,
      fingerprint,
      reused: false,
    };
  } catch (error) {
    return {
      note: buildTemplateDispatchNote(incident),
      source: DISPATCH_NOTE_SOURCES.TEMPLATE_FALLBACK,
      fingerprint,
      reused: false,
      error: error.message,
    };
  }
}

export function buildDispatchNoteFingerprint(incident) {
  return createHash('sha256')
    .update(JSON.stringify(buildDispatchNoteInput(incident)))
    .digest('hex');
}

export function buildDispatchNoteInput(incident) {
  return {
    id: incident.id,
    status: incident.status,
    type: incident.type,
    boundaryPoleId: incident.boundaryPoleId,
    boundaryParentId: incident.boundaryParentId,
    coordinates: {
      lat: nullableNumber(incident.lat),
      lon: nullableNumber(incident.lon),
    },
    pincode: incident.pincode,
    affectedPoleCount: incident.affectedPoleCount,
    confidence: nullableNumber(incident.confidence),
    confidenceReason: incident.confidenceReason,
    topologySource: incident.topologySource,
  };
}

export function buildTemplateDispatchNote(incident) {
  const typeLabel = formatIncidentType(incident.type).toUpperCase();
  const location = formatIncidentLocation(incident);
  const pincode = incident.pincode ? `, ${incident.pincode}` : '';
  const affected = Number(incident.affectedPoleCount ?? 0);
  const confidence = formatConfidence(incident.confidence);
  const caveat = needsVerificationCaveat(incident)
    ? ' Location is an estimate - verify at the pole before starting work.'
    : '';

  return `${typeLabel} near ${location}${pincode}, ~${affected} homes/service points affected. Confidence: ${confidence} (${incident.confidenceReason}).${caveat}`;
}

export function buildDispatchNotePrompt(incident) {
  return [
    'Write a 3-4 sentence plain-language dispatch note for an electricity field crew.',
    'A control-room operator should be able to read it aloud or paste it into WhatsApp.',
    'Use only the incident JSON below; do not infer new fault locations, do not analyze raw telemetry, and do not add unstated facts.',
    'Include what is broken, where exactly, how many homes/service points are affected, and the confidence.',
    'If confidence is below 80% or topologySource is not surveyed, explicitly say: "location is an estimate - verify at the pole before starting work" in natural prose.',
    'Return prose only, with no bullets, headings, JSON, markdown, or sign-off.',
    '',
    JSON.stringify(buildDispatchNoteInput(incident), null, 2),
  ].join('\n');
}

async function callAnthropicForDispatchNote(incident, options) {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured.');
  }

  const timeoutMs =
    options.timeoutMs ?? DEFAULT_DISPATCH_NOTE_TIMEOUT_MS;
  const controller = new globalThis.AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (options.fetch ?? globalThis.fetch)(
      options.apiUrl ?? ANTHROPIC_MESSAGES_URL,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model:
            options.model ??
            process.env.ANTHROPIC_MODEL ??
            DEFAULT_ANTHROPIC_MODEL,
          max_tokens: 220,
          system:
            'You format deterministic utility incident data into concise dispatch prose. You are not doing diagnosis or localization.',
          messages: [
            {
              role: 'user',
              content: buildDispatchNotePrompt(incident),
            },
          ],
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Anthropic request failed with ${response.status}.`);
    }

    const payload = await response.json();
    const text = extractAnthropicText(payload);

    if (!text) {
      throw new Error('Anthropic response did not include text content.');
    }

    return text;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function extractAnthropicText(payload) {
  return payload.content
    ?.filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function needsVerificationCaveat(incident) {
  return (
    nullableNumber(incident.confidence) < 0.8 ||
    incident.topologySource !== 'surveyed'
  );
}

function formatIncidentLocation(incident) {
  if (incident.boundaryParentId && incident.boundaryPoleId) {
    return `${incident.boundaryParentId}/${incident.boundaryPoleId}`;
  }

  if (incident.boundaryPoleId) {
    return incident.boundaryPoleId;
  }

  if (incident.dtId) {
    return incident.dtId;
  }

  return incident.feederId ?? 'reported boundary';
}

function formatIncidentType(type) {
  const labels = {
    span: 'span fault',
    dt: 'DT outage',
    feeder: 'feeder outage',
    sensor_fault: 'sensor fault',
  };

  return labels[type] ?? type;
}

function formatConfidence(value) {
  const numeric = nullableNumber(value);

  if (!Number.isFinite(numeric)) {
    return 'unknown';
  }

  return `${Math.round(numeric * 100)}%`;
}

function nullableNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const numeric = Number(value);

  return Number.isFinite(numeric) ? numeric : null;
}
