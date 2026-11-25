/**
 * The HTTP server of the push relay, for Node 24 or later. It needs no dependencies and no build step:
 * `node src/server.ts` runs the TypeScript file directly.
 *
 * The configuration comes from the environment (see README.md). The relay keeps no files. Put it behind HTTPS, for
 * example the TLS proxy of the host.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { readFileSync } from 'node:fs';
import { checkConfig, createRelay, type ApnsRequest, type ApnsResponse } from './relay.ts';

const MAX_BODY_BYTES = 8192;
const APNS_TIMEOUT_MS = 10_000;

function log(message: string): void {
    console.log(`${new Date().toISOString()} ${message}`);
}

function privateKey(): string | undefined {
    if (process.env.APNS_PRIVATE_KEY) return process.env.APNS_PRIVATE_KEY.replace(/\\n/g, '\n');
    if (process.env.APNS_PRIVATE_KEY_FILE) return readFileSync(process.env.APNS_PRIVATE_KEY_FILE, 'utf8');
    return undefined;
}

const config = checkConfig({
    secret: process.env.RELAY_SECRET,
    teamId: process.env.APNS_TEAM_ID,
    keyId: process.env.APNS_KEY_ID,
    privateKey: privateKey(),
    topic: process.env.APNS_TOPIC ?? 'dev.shipwarden.ios'
});

/** One HTTP/2 connection for each APNs host. APNs asks the providers to keep the connection open. */
const sessions = new Map<string, ClientHttp2Session>();

function session(host: string): ClientHttp2Session {
    const current = sessions.get(host);
    if (current && !current.closed && !current.destroyed) return current;
    const next = connect(`https://${host}`);
    next.on('error', error => log(`APNs connection error (${host}): ${error.message}`));
    next.on('close', () => sessions.delete(host));
    sessions.set(host, next);
    return next;
}

function sendToApns(request: ApnsRequest): Promise<ApnsResponse> {
    return new Promise((resolve, reject) => {
        const stream = session(request.host).request({
            [constants.HTTP2_HEADER_METHOD]: 'POST',
            [constants.HTTP2_HEADER_PATH]: `/3/device/${request.deviceToken}`,
            'content-type': 'application/json',
            ...request.headers
        });
        stream.setTimeout(APNS_TIMEOUT_MS, () => stream.close(constants.NGHTTP2_CANCEL));
        let status = 0;
        let text = '';
        stream.on('response', headers => {
            status = Number(headers[constants.HTTP2_HEADER_STATUS]);
        });
        stream.setEncoding('utf8');
        stream.on('data', chunk => {
            text += chunk;
        });
        stream.on('end', () => {
            let reason: string | undefined;
            try {
                reason = text ? (JSON.parse(text) as { reason?: string }).reason : undefined;
            } catch {
                reason = undefined;
            }
            resolve({ status, reason });
        });
        stream.on('error', reject);
        stream.end(request.body);
    });
}

const relay = createRelay(config, sendToApns);

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new Error('too large');
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** The address of the client. Behind a proxy, set TRUST_PROXY=1 to read X-Forwarded-For. */
function clientIp(request: IncomingMessage): string | undefined {
    const forwarded = request.headers['x-forwarded-for'];
    if (process.env.TRUST_PROXY === '1' && typeof forwarded === 'string') return forwarded.split(',')[0]?.trim();
    return request.socket.remoteAddress;
}

const server = createServer(async (request, response) => {
    let body = '';
    try {
        body = await readBody(request);
    } catch {
        response.writeHead(413, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'The request is too large.' }));
        return;
    }
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(request.headers)) headers[name] = Array.isArray(value) ? value[0] : value;
    const result = await relay.handle({
        method: request.method ?? 'GET',
        path: new URL(request.url ?? '/', 'http://relay').pathname,
        headers,
        body,
        ip: clientIp(request)
    });
    // The log has no device tokens, tickets, or worktree names.
    if (result.status >= 400) log(`${request.method} ${request.url} ${result.status}`);
    const text = JSON.stringify(result.body);
    response.writeHead(result.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    response.end(text);
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => log(`The ShipWarden push relay listens on port ${port}.`));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        server.close();
        for (const item of sessions.values()) item.close();
        process.exit(0);
    });
}
