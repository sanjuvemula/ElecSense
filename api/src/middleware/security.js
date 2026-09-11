import { rateLimit } from 'express-rate-limit';

// Telemetry is machine traffic: a single field gateway can legitimately post
// large batches in bursts, so this limit is deliberately looser than the
// operator-facing one and is only meant to stop runaway or hostile clients.
export const TELEMETRY_WINDOW_MS = 60 * 1000;
export const TELEMETRY_MAX_REQUESTS = 120;

// Operator actions (acknowledge, assign, resolve, close, simulate) are human
// paced. A human cannot legitimately exceed this from one address.
export const MUTATION_WINDOW_MS = 60 * 1000;
export const MUTATION_MAX_REQUESTS = 60;

export const READ_WINDOW_MS = 60 * 1000;
export const READ_MAX_REQUESTS = 600;

function buildLimiter({ windowMs, limit, name }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: 'Too many requests',
        message: `Rate limit exceeded for ${name}. Retry after the window resets.`,
      });
    },
  });
}

export const telemetryLimiter = buildLimiter({
  windowMs: TELEMETRY_WINDOW_MS,
  limit: TELEMETRY_MAX_REQUESTS,
  name: 'telemetry ingestion',
});

export const mutationLimiter = buildLimiter({
  windowMs: MUTATION_WINDOW_MS,
  limit: MUTATION_MAX_REQUESTS,
  name: 'operator actions',
});

export const readLimiter = buildLimiter({
  windowMs: READ_WINDOW_MS,
  limit: READ_MAX_REQUESTS,
  name: 'read endpoints',
});

/**
 * Rejects state-changing requests that do not present the shared operator
 * token.
 *
 * Enforcement is opt-in: with no OPERATOR_TOKEN configured the middleware
 * passes everything through and logs a single warning at boot. That keeps a
 * fresh clone and the public demo working, while giving any deployment that
 * cares a way to lock down writes without a code change.
 *
 * This is a deployment guard, not user authentication. A browser SPA cannot
 * hold a secret, so a token shipped to the frontend is readable by anyone who
 * opens devtools. Use it for machine clients and private deployments; real
 * per-user access control needs a login system and sessions.
 */
export function requireOperatorToken(options = {}) {
  const token = options.token ?? process.env.OPERATOR_TOKEN;

  if (!token) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    if (readTokenFromRequest(req) === token) {
      next();
      return;
    }

    res.status(401).json({
      error: 'Unauthorized',
      message: 'A valid operator token is required for this action.',
    });
  };
}

export function warnIfWritesAreUnprotected(logger = console) {
  if (process.env.OPERATOR_TOKEN) {
    return false;
  }

  logger.warn(
    'OPERATOR_TOKEN is not set: telemetry ingestion, incident actions and ' +
      'simulator injection are open to anyone who can reach this API. Set ' +
      'OPERATOR_TOKEN to require a shared token on state-changing requests.',
  );

  return true;
}

function readTokenFromRequest(req) {
  const header = req.get('authorization');

  if (header?.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }

  return req.get('x-operator-token')?.trim() ?? null;
}
