import type { Envelope, QuestionsResponse } from '../types';

/**
 * All ApplynBuyAPI responses arrive as { code, status, response: <payload> }.
 * Verified on NAAP stg (Acquire v2.5.20): `response` is a plain JSON object.
 * Older deployments base64-encode it. Accept both here and nowhere else.
 */
export function decodeEnvelope<T = QuestionsResponse>(env: Envelope): T {
  const payload = env?.response as unknown;
  if (payload !== null && typeof payload === 'object') return payload as T;
  if (typeof payload !== 'string') {
    throw new Error(`Unexpected envelope shape: ${JSON.stringify(env).slice(0, 300)}`);
  }
  const json = Buffer.from(payload, 'base64').toString('utf8');
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new Error(`Envelope decoded but is not JSON (first 200 chars): ${json.slice(0, 200)}`);
  }
}
