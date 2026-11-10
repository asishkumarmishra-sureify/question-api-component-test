import type { APIRequestContext } from '@playwright/test';
import { CognitoAuth } from './auth';
import { decodeEnvelope } from './envelope';
import type { Adm, QuestionsEvent, QuestionsResponse } from '../types';

export interface ClientConfig {
  /** 'legacy' = POST /api/questions (uid in query/body) · 'v4' = /api/v4/acquire/* */
  apiStyle: 'legacy' | 'v4';
  auth?: CognitoAuth;
  /** Sent as ?language=… on every call (verified: NAAP stg uses en-US). */
  language?: string;
  /** Observer for every exchange (decoded payloads). The fixture uses it to
   *  attach request/response to the Playwright report. */
  onExchange?: (x: ApiExchange) => void | Promise<void>;
}

export interface ApiExchange {
  seq: number;
  method: 'GET' | 'POST';
  url: string;
  request?: unknown;
  status: number;
  durationMs: number;
  response: unknown;
}

/**
 * Thin, typed wrapper over the Acquire question API.
 * Normalizes the two endpoint generations behind one interface and
 * handles the base64 envelope so nothing above this layer sees it.
 *
 * TODO(pilot): verify exact paths + auth header shape against the NAAP dev
 * env (legacy carriers also accept cognito_id_token in the body — see the
 * recorded traffic). Adjust in ONE place: here.
 */
export class AcquireApiClient {
  private seq = 0;
  constructor(private request: APIRequestContext, private cfg: ClientConfig) {}

  private async record(method: 'GET' | 'POST', url: string, request: unknown, status: number, startedAt: number, response: unknown) {
    if (!this.cfg.onExchange) return;
    await this.cfg.onExchange({ seq: ++this.seq, method, url, request, status, durationMs: Date.now() - startedAt, response });
  }

  private path(name: 'questions' | 'application-data-model' | 'prefill-config' | 'variant-tags', extraQuery: Record<string, string> = {}) {
    const base = this.cfg.apiStyle === 'v4' ? `/api/v4/acquire/${name}` : `/api/${name}`;
    const q = new URLSearchParams({ language: this.cfg.language ?? 'en-US', ...extraQuery });
    return `${base}?${q.toString()}`;
  }

  private async headers(): Promise<Record<string, string>> {
    if (!this.cfg.auth) return {};
    return { authorization: `Bearer ${await this.cfg.auth.bearer(this.request)}` };
  }

  async questions(body: {
    uid?: string;
    event_type: QuestionsEvent;
    application_data_model?: Adm;
    [k: string]: unknown;
  }): Promise<QuestionsResponse> {
    const url = this.path('questions');
    const t0 = Date.now();
    const resp = await this.request.post(url, {
      headers: await this.headers(),
      data: body,
    });
    if (!resp.ok()) {
      const text = await resp.text();
      await this.record('POST', url, body, resp.status(), t0, text.slice(0, 2000));
      throw new Error(`questions ${body.event_type} -> HTTP ${resp.status()}: ${text.slice(0, 300)}`);
    }
    const decoded = decodeEnvelope(await resp.json());
    await this.record('POST', url, body, resp.status(), t0, decoded);
    return decoded;
  }

  /**
   * Read the persisted ADM. Verified on NAAP stg: the backend route is
   * GET api/v4/acquire/application-data-model?uid=…; the Express layer in
   * front of the legacy `/api/*` prefix only proxies POSTs (a GET there
   * returns the SPA's index.html), so reads ALWAYS go to the v4 path.
   */
  async getApplicationDataModel(uid: string): Promise<Adm> {
    const q = new URLSearchParams({ uid, language: this.cfg.language ?? 'en-US' });
    const url = `/api/v4/acquire/application-data-model?${q}`;
    const t0 = Date.now();
    const resp = await this.request.get(url, { headers: await this.headers() });
    if (!resp.ok()) {
      await this.record('GET', url, undefined, resp.status(), t0, (await resp.text()).slice(0, 2000));
      throw new Error(`get ADM -> HTTP ${resp.status()}`);
    }
    const decoded = decodeEnvelope<{ application_data_model?: Adm } & Adm>(await resp.json());
    await this.record('GET', url, undefined, resp.status(), t0, decoded);
    return (decoded.application_data_model ?? decoded) as Adm;
  }

  /** Verified on NAAP stg: POST /api/application-data-model?uid=… with
   *  { application_data_model } (400 "please provide data modal" without it). */
  async postApplicationDataModel(uid: string, adm: Adm): Promise<void> {
    const url = this.path('application-data-model', { uid });
    const body = { uid, application_data_model: adm };
    const t0 = Date.now();
    const resp = await this.request.post(url, { headers: await this.headers(), data: body });
    await this.record('POST', url, body, resp.status(), t0, resp.ok() ? await resp.json() : (await resp.text()).slice(0, 2000));
    if (!resp.ok()) throw new Error(`post ADM -> HTTP ${resp.status()}`);
  }
}
