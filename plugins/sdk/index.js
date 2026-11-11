// The JavaScript SDK for ShipWarden task plugins. It has no dependencies.
// It reads JSON-RPC messages with Content-Length headers from stdin, calls the handlers and writes the results to stdout.
// The protocol: docs/task-plugin-protocol.md

const HANDLERS = {
    initialize: 'initialize',
    'scopes/list': 'listScopes',
    'collections/list': 'listCollections',
    'tasks/list': 'listTasks',
    'tasks/get': 'getTask',
    'tasks/update': 'updateTask',
    'tasks/create': 'createTask',
    'tasks/delete': 'deleteTask',
    'tasks/statuses': 'listStatuses',
    'tasks/statusOrder': 'statusOrder',
    'comments/list': 'listComments',
    'comments/create': 'createComment',
    'tasks/action': 'runAction',
    'activity/list': 'listActivity',
    'people/list': 'listPeople',
    'tasks/options': 'listOptions'
};

/** A JSON-RPC error code for a method that the plugin does not have. */
const METHOD_NOT_FOUND = -32601;
/** A JSON-RPC error code for a failed request. */
const REQUEST_FAILED = -32803;

/**
 * Splits a byte stream into messages. Each message has a Content-Length header and a JSON body.
 * Returns a function that takes the next chunk and returns the complete messages.
 */
export function createMessageParser() {
    let buffer = Buffer.alloc(0);
    return chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        const messages = [];
        for (;;) {
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) {
                break;
            }
            const header = buffer.subarray(0, headerEnd).toString('ascii');
            const match = /Content-Length:\s*(\d+)/i.exec(header);
            if (!match) {
                // The header is not valid. Remove it and continue with the next data.
                buffer = buffer.subarray(headerEnd + 4);
                continue;
            }
            const length = Number(match[1]);
            const start = headerEnd + 4;
            if (buffer.length < start + length) {
                break;
            }
            messages.push(JSON.parse(buffer.subarray(start, start + length).toString('utf8')));
            buffer = buffer.subarray(start + length);
        }
        return messages;
    };
}

/** Returns a message with its Content-Length header. */
export function encodeMessage(message) {
    const body = JSON.stringify(message);
    return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

/**
 * Starts the plugin. `handlers` has one async function for each request that the plugin supports.
 * The SDK adds the capabilities from the handlers to the initialize result.
 * Returns an object with `notify(method, params)`, for example to send "tasks/changed".
 */
export function runPlugin(handlers, { input = process.stdin, output = process.stdout, exit = code => process.exit(code) } = {}) {
    // Each task source has collections (for example ClickUp lists or GitHub repositories). The task view shows one at a time.
    for (const required of ['initialize', 'listCollections', 'listTasks', 'getTask']) {
        if (typeof handlers[required] !== 'function') {
            throw new Error(`A ShipWarden task plugin must have the handler "${required}".`);
        }
    }
    const write = message => output.write(encodeMessage(message));
    const parse = createMessageParser();

    const handle = async message => {
        if (message.id === undefined) {
            // ShipWarden sends no notifications in protocol version 1.
            return;
        }
        if (message.method === 'shutdown') {
            write({ jsonrpc: '2.0', id: message.id, result: null });
            setTimeout(() => exit(0), 50);
            return;
        }
        const name = HANDLERS[message.method];
        const handler = name && handlers[name];
        if (!handler) {
            write({ jsonrpc: '2.0', id: message.id, error: { code: METHOD_NOT_FOUND, message: `The plugin does not support "${message.method}".` } });
            return;
        }
        try {
            let result = await handler(message.params ?? {});
            if (message.method === 'initialize') {
                result = {
                    ...result,
                    capabilities: {
                        update: !!handlers.updateTask,
                        create: !!handlers.createTask,
                        delete: !!handlers.deleteTask,
                        statuses: !!handlers.listStatuses,
                        statusOrder: !!handlers.statusOrder,
                        comments: !!(handlers.listComments && handlers.createComment),
                        actions: !!handlers.runAction,
                        scopes: !!handlers.listScopes,
                        activity: !!handlers.listActivity,
                        assignees: !!handlers.listPeople,
                        options: !!handlers.listOptions,
                        ...(result?.capabilities ?? {})
                    }
                };
            }
            write({ jsonrpc: '2.0', id: message.id, result: result ?? null });
        } catch (error) {
            write({ jsonrpc: '2.0', id: message.id, error: { code: REQUEST_FAILED, message: error instanceof Error ? error.message : String(error) } });
        }
    };

    input.on('data', chunk => {
        for (const message of parse(chunk)) {
            handle(message);
        }
    });
    input.on('end', () => exit(0));

    return {
        notify(method, params) {
            write({ jsonrpc: '2.0', method, params });
        }
    };
}

/** Writes a log line to stderr. ShipWarden shows plugin logs in its own log. */
export function log(...parts) {
    process.stderr.write(`${parts.map(part => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')}\n`);
}

const CERTIFICATE_ERROR_CODES = new Set([
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_UNTRUSTED'
]);

/**
 * Describes a failed fetch. Node puts the real reason, for example a certificate error, in `cause`.
 * For a certificate error, the text tells the user where to set the CA certificates of their network.
 */
export function networkDetail(error) {
    const message = error?.message ?? String(error);
    const cause = error?.cause;
    const code = typeof cause?.code === 'string' ? cause.code : undefined;
    const detail = code ?? (typeof cause?.message === 'string' ? cause.message : undefined);
    const text = detail && !message.includes(detail) ? `${message} (${detail})` : message;
    return code && CERTIFICATE_ERROR_CODES.has(code)
        ? `${text}. The network possibly inspects TLS traffic, for example a company VPN. In Settings › Network, set the CA certificates file of your company, or trust the macOS keychain.`
        : text;
}
