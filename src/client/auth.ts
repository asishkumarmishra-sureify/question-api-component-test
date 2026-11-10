import type { APIRequestContext } from '@playwright/test';

/** Cognito M2M client-credentials. Token cached until near expiry. */
export class CognitoAuth {
  private token?: string;
  private expiresAt = 0;

  constructor(private cfg: {
    tokenUrl: string; clientId: string; clientSecret: string; scope?: string;
  }) {}

  async bearer(request: APIRequestContext): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    const resp = await request.post(this.cfg.tokenUrl, {
      // Explicit: the Playwright project sets a JSON content-type via
      // extraHTTPHeaders, which would otherwise override the form encoding
      // Cognito requires (verified: it answers with an HTML error page).
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      form: {
        grant_type: 'client_credentials',
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        ...(this.cfg.scope ? { scope: this.cfg.scope } : {}),
      },
    });
    if (!resp.ok()) throw new Error(`Cognito token request failed: ${resp.status()} ${await resp.text()}`);
    const body = await resp.json();
    this.token = body.access_token;
    this.expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.token!;
  }
}
