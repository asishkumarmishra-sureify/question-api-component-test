import type { APIRequestContext } from '@playwright/test';
import { CognitoAuth } from './auth';
import { decodeEnvelope } from './envelope';
import type { Adm, QuestionsEvent, QuestionsResponse } from '../types';

export interface ClientConfig {
  /** 'legacy' = POST /api/questions (uid in query/body) · 'v4' = /api/v4/acquire/* */
  apiStyle: 'legacy' | 'v4';
  auth?: CognitoAuth;
  /** Sent as ?language=… on every call. Defaults to en-US. */
  language?: string;
  /** Path prefix of the e-signature service (Concordia) on the same host:
   *  `/<clientId>/api/v5/concordia`. Defaults to clientId `aaanaapstg`. */
  esignClientId?: string;
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
  /** Origin of the eApp front end, learned from launch links (cutover, current-assignee). */
  private eAppOrigin?: string;
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
    /** Omitted when (re)opening an existing application by uid — the page-load call. */
    event_type?: QuestionsEvent;
    application_data_model?: Adm;
    [k: string]: unknown;
  }, query: Record<string, string> = {}): Promise<QuestionsResponse> {
    // `query` carries `euid` while a handed-off session is still behind its identity check.
    const url = this.path('questions', query);
    const t0 = Date.now();
    const resp = await this.request.post(url, {
      headers: await this.headers(),
      data: body,
    });
    if (!resp.ok()) {
      const text = await resp.text();
      await this.record('POST', url, body, resp.status(), t0, text.slice(0, 2000));
      throw new Error(`questions ${body.event_type ?? 'open'} -> HTTP ${resp.status()}: ${text.slice(0, 300)}`);
    }
    const decoded = decodeEnvelope(await resp.json());
    await this.record('POST', url, body, resp.status(), t0, decoded);
    return decoded;
  }

  /**
   * Agent-panel entry point ("Initiate > Begin Quote"): creates an application
   * for the agent and returns its uid. The response is NOT the questions
   * envelope: `{ code, data: { url: "<eApp host>/?uid=<uid>" }, errors }`.
   * The agent context travels as headers, the agent's details as `payload`.
   */
  async cutover(agent: Record<string, unknown>, ctx: { agentId?: string; userRole?: string } = {}): Promise<string> {
    const url = '/api/v3/photon/cutover';
    const body = { payload: agent };
    const t0 = Date.now();
    const resp = await this.request.post(url, {
      headers: {
        ...(await this.headers()),
        ...(ctx.agentId ? { agent_id: ctx.agentId } : {}),
        user_role: ctx.userRole ?? 'Agent',
        display_quote_experiences: 'false',
      },
      data: body,
    });
    const text = await resp.text();
    let json: any; 
    try { json = JSON.parse(text); } catch { json = undefined; }
    
    await this.record('POST', url, body, resp.status(), t0, json ?? text.slice(0, 2000));
    const launch = json?.data?.url;
    if (!resp.ok() || !launch) throw new Error(`cutover -> HTTP ${resp.status()}: ${text.slice(0, 300)}`);
    const uid = new URL(launch).searchParams.get('uid');
    if (!uid) throw new Error(`cutover returned a launch url without uid: ${launch}`);
    this.eAppOrigin = new URL(launch).origin;
    return uid;
  }

  /**
   * Launch link of the role the application is currently assigned to (the same
   * link the hand-off email carries): `…/?euid=<encrypted session id>`.
   * Returns the `euid`. Remembers the eApp origin for the signing step.
   */
  async currentAssigneeEuid(uid: string): Promise<string> {
    const url = `/api/v4/acquire/app-sessions/current-assignee?${new URLSearchParams({ uid })}`;
    const t0 = Date.now();
    const resp = await this.request.get(url, { headers: await this.headers() });
    const text = await resp.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    const launch: string | undefined = json?.response?.data?.url;
    const euid = launch ? new URL(launch).searchParams.get('euid') : null;
    // The euid is a session credential: keep it out of the report.
    await this.record('GET', url, undefined, resp.status(), t0, euid ? { launch_url: launch!.replace(euid, '<euid>') } : json ?? text.slice(0, 2000));
    if (!resp.ok() || !euid) throw new Error(`current-assignee -> HTTP ${resp.status()}: ${text.slice(0, 300)}`);
    this.eAppOrigin = new URL(launch!).origin;
    return euid;
  }

  // ---- e-signature service (Concordia). The question API hands out the
  // payload; rendering and signing the documents happens here. ----
  private esignBase() { return `/${this.cfg.esignClientId ?? 'aaanaapstg'}/api/v5/concordia`; }

  /** Queue document generation for a signing session. `payload` and its hash
   *  come verbatim from the 'e-signature' questions response. Returns the job key. */
  async esignStart(o: { feature: string; payload: string; payloadHash: string; signatory: string; traceId: string }): Promise<string> {
    const url = `${this.esignBase()}/esignatures/${o.feature}`;
    const t0 = Date.now();
    const resp = await this.request.post(url, {
      headers: { ...(await this.headers()), 'content-type': 'text/plain', 'x-payload-signature': o.payloadHash, 'x-signatory': o.signatory, 'x-lifetime-trace-id': o.traceId },
      data: o.payload,
    });
    const text = await resp.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    await this.record('POST', url, { payload: `<${o.payload.length} chars>`, signatory: o.signatory }, resp.status(), t0, json?.data?.job_key ? { code: json.code, job_key: '<job key>' } : json ?? text.slice(0, 2000));
    if (!resp.ok() || !json?.data?.job_key) throw new Error(`esign start -> HTTP ${resp.status()}: ${text.slice(0, 300)}`);
    return json.data.job_key;
  }

  /** Wait for the queued job (server-sent events) and return its result:
   *  `{ type, signing_id, envelope: { envelope_id, documents: [{ document_id, data: base64 PDF }] } }`. */
  async esignAwaitEnvelope(jobKey: string, traceId: string, timeoutMs = 75_000): Promise<any> {
    const url = `${this.esignBase()}/esignature-jobs/listen?${new URLSearchParams({ job_key: jobKey, trace_id: traceId })}`;
    const shown = url.replace(encodeURIComponent(jobKey), '<job key>').replace(jobKey, '<job key>');
    const t0 = Date.now();
    let resp;
    try {
      resp = await this.request.get(url, { headers: { ...(await this.headers()), accept: 'text/event-stream' }, timeout: timeoutMs });
    } catch (e) {
      // The stream stayed open without a result. Report it without the request
      // dump Playwright attaches (it would carry the bearer token and job key).
      await this.record('GET', shown, undefined, 0, t0, `no result within ${timeoutMs / 1000}s`);
      throw new EsignJobTimeout(`esign job produced no envelope within ${timeoutMs / 1000}s`);
    }
    const text = await resp.text();
    const events = text.split('\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5)); } catch { return undefined; } }).filter(Boolean);
    const done = events.reverse().find((e: any) => e?.data?.envelope);
    await this.record('GET', shown, undefined, resp.status(), t0, done ? summarizeEnvelope(done.data) : text.slice(0, 2000));
    if (!resp.ok() || !done) throw new Error(`esign job -> HTTP ${resp.status()}: ${text.slice(0, 300)}`);
    return done.data;
  }

  /** Apply the signature to the envelope. `input` and its hash come verbatim
   *  from the `esignature` custom call. Returns `{ sign_status, signing_id, documents }`. */
  async esignSign(o: { feature: string; envelopeId: string; signingId: string; uid: string; input: unknown; payloadHash: string }): Promise<any> {
    const url = `${this.esignBase()}/esignatures/${o.feature}/sign-status`;
    const body = { envelope_id: o.envelopeId, signing_id: o.signingId, url: `${this.eAppOrigin ?? ''}/click-sign?uid=${o.uid}`, input: o.input, sign_status: 1 };
    const t0 = Date.now();
    const resp = await this.request.post(url, { headers: { ...(await this.headers()), 'x-payload-signature': o.payloadHash }, data: body, timeout: 180_000 });
    const text = await resp.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    await this.record('POST', url, body, resp.status(), t0, json?.data ? { code: json.code, ...summarizeEnvelope({ ...json.data, envelope: json.data }) } : json ?? text.slice(0, 2000));
    if (!resp.ok() || !json?.data) throw new Error(`esign sign-status -> HTTP ${resp.status()}: ${text.slice(0, 300)}`);
    return json.data;
  }

  /**
   * Proxy for a button question's configured API (`properties.button_config.api_config`),
   * e.g. the quote page's "Get Your Quote" -> quote/spark-quote. Returns the
   * whole `{ code, status, response }` envelope, because that envelope is what
   * the application stores as the button's answer.
   */
  async custom(body: { uid: string; requestUrl: string; requestMethod: string; headers?: Record<string, string>; params: Record<string, unknown>; enableRetry?: boolean }): Promise<{ code: number; status: boolean; response: any }> {
    const url = '/api/custom';
    const t0 = Date.now();
    const resp = await this.request.post(url, { headers: await this.headers(), data: body });
    const text = await resp.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    await this.record('POST', url, body, resp.status(), t0, json ?? text.slice(0, 2000));
    if (!resp.ok() || !json) throw new Error(`custom ${body.requestUrl} -> HTTP ${resp.status()}: ${text.slice(0, 300)}`);
    return json;
  }

  /**
   * Read the persisted ADM. The backend route is
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

  /** Write the persisted ADM: POST /api/application-data-model?uid=… with
   *  { application_data_model } (the server answers 400 "please provide data modal" without it). */
  async postApplicationDataModel(uid: string, adm: Adm): Promise<void> {
    const url = this.path('application-data-model', { uid });
    const body = { uid, application_data_model: adm };
    const t0 = Date.now();
    const resp = await this.request.post(url, { headers: await this.headers(), data: body });
    await this.record('POST', url, body, resp.status(), t0, resp.ok() ? await resp.json() : (await resp.text()).slice(0, 2000));
    if (!resp.ok()) throw new Error(`post ADM -> HTTP ${resp.status()}`);
  }
}

/** The signing service kept the job stream open past the wait without delivering an envelope. */
export class EsignJobTimeout extends Error {}

/** Report-friendly view of an envelope: document ids and sizes, not megabytes of base64 PDF. */
function summarizeEnvelope(data: any) {
  const docs = data?.envelope?.documents ?? [];
  return {
    type: data?.type, signing_id: data?.signing_id, sign_status: data?.sign_status,
    envelope_id: data?.envelope?.envelope_id,
    documents: docs.map((d: any) => ({ document_id: d.document_id, base64_chars: String(d.data ?? '').length })),
  };
}
