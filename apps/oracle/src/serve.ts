/**
 * A loopback listener, so the app can ask for a meal to be graded.
 *
 * Bound to 127.0.0.1 and nothing else. This process holds a key, and a key
 * behind an HTTP port should be reachable by exactly the machine it sits on.
 * There is no token on this: anything already running as this user could
 * call it, and anything running as this user can read the key file too, so a
 * token would guard the smaller of the two doors.
 *
 * What a caller can do with it is bounded by the contract rather than by
 * this: `award_feed_xp` pays once per meal and refuses the second attempt, a
 * meal has to have been bought with real credits to exist, and the key
 * cannot do anything else at all. The worst a local caller achieves is
 * paying out XP for somebody's genuine meal slightly sooner than the app
 * would have asked.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { gradeMeal, type Grader } from './grade.ts';

const MAX_BODY = 4096;

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // A listener that will accept an unbounded body is a way to exhaust the
    // process that is meant to be feeding people's pets.
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

export function serve(
  port: number,
  deps: Grader,
  log: (message: string, extra?: Record<string, unknown>) => void
) {
  const server = createServer(async (request, response) => {
    /*
     * Every request, before anything can reject it. A grade that never
     * arrives and a grade that arrives and is refused look identical in a
     * log that only records the second — which is exactly the hole I fell
     * into chasing a feed that earned no XP.
     */
    log('request', { method: request.method, url: request.url });

    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        'content-type': 'application/json',
        // The desktop app is a `tauri://localhost` origin, so the browser in
        // it treats this as cross-origin and will not send the POST without
        // this. Loopback is the real boundary; this only unblocks the app.
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'POST, OPTIONS'
      });
      response.end(JSON.stringify(body));
    };

    if (request.method === 'OPTIONS') return send(204, {});
    if (request.url === '/health') return send(200, { ok: true });
    if (request.method !== 'POST' || request.url !== '/grade') {
      return send(404, { error: 'POST /grade' });
    }

    let body: unknown;
    try {
      body = await readBody(request);
    } catch (error) {
      return send(400, { error: error instanceof Error ? error.message : 'bad body' });
    }

    const txHash = String((body as { txHash?: unknown })?.txHash ?? '').trim();
    const accountId = String((body as { accountId?: unknown })?.accountId ?? '').trim();

    const outcome = await gradeMeal(txHash, accountId, deps);
    if (!outcome.ok) {
      log('grade refused', { txHash, why: outcome.why });
      return send(outcome.status, { error: outcome.why });
    }
    log('graded', { ...outcome });
    send(200, outcome);
  });

  server.listen(port, '127.0.0.1', () => log('listening', { port }));
  return server;
}
