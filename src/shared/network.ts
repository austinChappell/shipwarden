/** The TLS error codes that a network which inspects TLS traffic (for example a company VPN) causes. */
export const CERTIFICATE_ERROR_CODES = new Set([
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_UNTRUSTED'
]);

export const CERTIFICATE_HINT =
    'The network possibly inspects TLS traffic, for example a company VPN. ' +
    'In Settings › Network, set the CA certificates file of your company, or trust the macOS keychain.';

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Returns each PEM certificate in a bundle. Text outside the certificates is ignored. */
export function pemBlocks(text: string): string[] {
    return text.match(PEM_BLOCK) ?? [];
}

/** Returns the error code of a failed fetch. Node puts the real reason, for example a certificate error, in `cause`. */
export function networkErrorCode(error: unknown): string | undefined {
    const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
    const code = typeof cause?.code === 'string' ? cause.code : (error as { code?: unknown } | undefined)?.code;
    return typeof code === 'string' ? code : undefined;
}

/** Describes a failed fetch, with the reason from `cause` and a hint for certificate errors. */
export function networkErrorDetail(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const code = networkErrorCode(error);
    const causeMessage = (error as { cause?: { message?: unknown } } | undefined)?.cause?.message;
    const detail = code ?? (typeof causeMessage === 'string' ? causeMessage : undefined);
    const text = detail && !message.includes(detail) ? `${message} (${detail})` : message;
    return code && CERTIFICATE_ERROR_CODES.has(code) ? `${text}. ${CERTIFICATE_HINT}` : text;
}
