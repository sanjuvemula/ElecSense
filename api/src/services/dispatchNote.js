import { createHash } from 'node:crypto';

import { GoogleGenAI } from '@google/genai';

export const DISPATCH_NOTE_SOURCES = Object.freeze({
  LLM: 'llm',
  TEMPLATE_FALLBACK: 'template-fallback',
});

export const DEFAULT_DISPATCH_NOTE_TIMEOUT_MS = 5000;
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

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
    const note = await callGeminiForDispatchNote(incident, options);

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

async function callGeminiForDispatchNote(incident, options) {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_DISPATCH_NOTE_TIMEOUT_MS;
  const request = {
    model: options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
    contents: buildDispatchNotePrompt(incident),
    config: {
      maxOutputTokens: 220,
      systemInstruction:
        'You format deterministic utility incident data into concise dispatch prose. You are not doing diagnosis or localization.',
    },
  };
  const generateContent =
    options.generateContent ??
    ((requestConfig) => {
      const client = options.client ?? new GoogleGenAI({ apiKey });

      return client.models.generateContent(requestConfig);
    });
  const response = await withTimeout(
    generateContent(request),
    timeoutMs,
    'Gemini request timed out.',
  );
  const text = extractGeminiText(response);

  if (!text) {
    throw new Error('Gemini response did not include text content.');
  }

  return text;
}

async function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

function extractGeminiText(response) {
  if (typeof response?.text === 'string') {
    return response.text.trim();
  }

  if (typeof response?.text === 'function') {
    return response.text().trim();
  }

  return response?.candidates
    ?.flatMap((candidate) => candidate.content?.parts ?? [])
    .filter((part) => typeof part.text === 'string')
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
