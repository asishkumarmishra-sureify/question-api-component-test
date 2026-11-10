import { test as base } from '@playwright/test';
import type { ApiExchange } from '../src/client/AcquireApiClient';
import { AcquireApiClient } from '../src/client/AcquireApiClient';
import { CognitoAuth } from '../src/client/auth';
import { ApplicationSession } from '../src/engine/ApplicationSession';
import { Catalog } from '../src/catalog/catalog';

interface AcquireFixture {
  startApplication(opts?: Record<string, unknown>): Promise<ApplicationSession>;
}

export const test = base.extend<{ acquire: AcquireFixture }>({
  // Boxed: the fixture's own setup (token fetch, client construction) is hidden
  // from the report's step tree; only journey steps and their API calls show.
  acquire: [async ({ request }, use) => {
    const catalog = new Catalog();
    const auth = process.env.NAAP_TOKEN_URL
      ? new CognitoAuth({
          tokenUrl: process.env.NAAP_TOKEN_URL!,
          clientId: process.env.NAAP_CLIENT_ID!,
          clientSecret: process.env.NAAP_CLIENT_SECRET!,
          scope: process.env.NAAP_OAUTH_SCOPE,
        })
      : undefined;
    const client = new AcquireApiClient(request, {
      apiStyle: (process.env.NAAP_API_STYLE as 'legacy' | 'v4') ?? 'legacy',
      language: process.env.NAAP_LANGUAGE ?? 'en-US',
      auth,
      // One attachment per API call, visible under the test in the HTML report:
      //   "03 POST /api/questions next_page -> 200 (1.2s)" with decoded request + response.
      onExchange: async (x: ApiExchange) => {
        const event = (x.request as any)?.event_type ? ` ${(x.request as any).event_type}` : '';
        const name = `${String(x.seq).padStart(2, '0')} ${x.method} ${x.url.split('?')[0]}${event} -> ${x.status} (${(x.durationMs / 1000).toFixed(1)}s)`;
        await base.info().attach(name, {
          contentType: 'application/json',
          body: JSON.stringify({ request: x.request, response: x.response }, null, 2),
        });
      },
    });
    if (auth) await auth.bearer(request);   // warm the token here (boxed) so no stray POST shows in journey steps
    // Every engine operation becomes a named, drill-down step in the report;
    // API attachments created inside it nest under that step.
    const step = <T,>(title: string, body: () => Promise<T> | T) => base.step(title, body);
    await use({
      startApplication: (opts = {}) => new ApplicationSession(client, catalog, { step }).start(opts),
    });
  }, { box: true }],
});

export { expect } from '@playwright/test';
