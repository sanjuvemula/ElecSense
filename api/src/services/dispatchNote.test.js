import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDispatchNoteFingerprint,
  buildTemplateDispatchNote,
  DISPATCH_NOTE_SOURCES,
  generateDispatchNote,
} from './dispatchNote.js';

test('reuses a stored dispatch note when the incident fingerprint matches', async () => {
  const incident = sampleIncident({
    dispatchNote: 'Stored note for the crew.',
  });
  const fingerprint = buildDispatchNoteFingerprint(incident);
  const result = await generateDispatchNote(
    {
      ...incident,
      dispatchNoteFingerprint: fingerprint,
      dispatchNoteSource: DISPATCH_NOTE_SOURCES.LLM,
    },
    {
      fetch: async () => {
        throw new Error('should not call provider');
      },
    },
  );

  assert.equal(result.reused, true);
  assert.equal(result.source, DISPATCH_NOTE_SOURCES.LLM);
  assert.equal(result.note, 'Stored note for the crew.');
});

test('uses Gemini text when the provider call succeeds', async () => {
  const result = await generateDispatchNote(sampleIncident(), {
    apiKey: 'test-key',
    generateContent: async (request) => {
      assert.equal(request.model, 'gemini-2.5-flash');
      assert.equal(request.config.maxOutputTokens, 220);
      assert.match(request.config.systemInstruction, /concise dispatch prose/);
      assert.match(request.contents, /affectedPoleCount/);
      assert.doesNotMatch(request.contents, /telemetry_events/);

      return { text: 'Crew note from Gemini.' };
    },
  });

  assert.equal(result.source, DISPATCH_NOTE_SOURCES.LLM);
  assert.equal(result.note, 'Crew note from Gemini.');
});

test('falls back to a deterministic template when the LLM fails', async () => {
  const result = await generateDispatchNote(sampleIncident(), {
    apiKey: 'test-key',
    generateContent: async () => {
      throw new Error('network down');
    },
  });

  assert.equal(result.source, DISPATCH_NOTE_SOURCES.TEMPLATE_FALLBACK);
  assert.match(result.note, /SPAN FAULT near P-024431\/P-024432/);
  assert.match(result.note, /location is an estimate/i);
  assert.equal(result.error, 'network down');
});

test('falls back to a deterministic template when Gemini times out', async () => {
  const result = await generateDispatchNote(sampleIncident(), {
    apiKey: 'test-key',
    timeoutMs: 1,
    generateContent: () => new Promise(() => {}),
  });

  assert.equal(result.source, DISPATCH_NOTE_SOURCES.TEMPLATE_FALLBACK);
  assert.match(result.note, /SPAN FAULT near P-024431\/P-024432/);
  assert.equal(result.error, 'Gemini request timed out.');
});

test('template note calls out inferred or low confidence locations', () => {
  const note = buildTemplateDispatchNote(
    sampleIncident({
      confidence: '0.72',
      topologySource: 'inferred',
    }),
  );

  assert.match(note, /Confidence: 72%/);
  assert.match(note, /verify at the pole before starting work/);
});

function sampleIncident(overrides = {}) {
  return {
    id: 'inc-1',
    status: 'detected',
    type: 'span',
    boundaryParentId: 'P-024431',
    boundaryPoleId: 'P-024432',
    lat: '12.9716000',
    lon: '77.5946000',
    pincode: '560001',
    affectedPoleCount: 18,
    confidence: '0.72',
    confidenceReason: 'inferred topology (MST), edge confidence 0.82',
    topologySource: 'inferred',
    dispatchNote: null,
    dispatchNoteSource: null,
    dispatchNoteFingerprint: null,
    ...overrides,
  };
}
