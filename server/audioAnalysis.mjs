// Server-side analysis boundary. Production deployments can point this at an
// AASIST/ECAPA worker; the fallback only scores metadata and never pretends to
// be a neural anti-spoofing model.
export function analyzeAudioFeatures({ durationMs = 0, rms = 0, timingMs = null, speakerSimilarity = null, spoofScore = null } = {}) {
  const timing = Number.isFinite(timingMs) ? Math.max(0, Math.min(100, 100 - Math.abs(timingMs - 30000) / 300)) : null;
  return {
    provider: process.env.GAZELINE_AUDIO_ANALYZER_URL ? 'remote-worker' : 'metadata-fallback',
    aasist: spoofScore == null ? { status: 'unavailable', score: null } : { status: 'scored', score: Math.max(0, Math.min(1, spoofScore)) },
    speakerVerification: speakerSimilarity == null ? { status: 'unavailable', similarity: null } : { status: 'scored', similarity: Math.max(0, Math.min(1, speakerSimilarity)) },
    responseTiming: { durationMs: Math.max(0, durationMs), score: timing },
    generatedAt: new Date().toISOString(),
  };
}

