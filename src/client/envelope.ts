import type { Envelope, QuestionsResponse } from '../types';

/**
 * All ApplynBuyAPI responses arrive as { code, status, response: <payload> }.
 * `response` is either a plain JSON object or a base64-encoded JSON string,
 * depending on the deployment. Accept both here and nowhere else.
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
