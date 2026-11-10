/**
 * The custom protocol that shows images from Azure DevOps, for example the images in a pull request description.
 * Azure DevOps requires a token for these images, so the page cannot load them directly.
 * A URL has the form `shipwarden-azure-image://image/?url=<Azure DevOps URL>`.
 * The main process gets the image with the token of the Azure DevOps provider.
 */
export const AZURE_IMAGE_SCHEME = 'shipwarden-azure-image';
const HOST = 'image';

/**
 * Returns the organization of an Azure DevOps API URL, or undefined for other URLs.
 * These hosts are Azure DevOps hosts:
 * - https://dev.azure.com/{org}/...
 * - https://{org}.visualstudio.com/...
 * The path must contain "/_apis/".
 */
export function azureApiOrganization(url: string): string | undefined {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !parsed.pathname.includes('/_apis/')) {
        return undefined;
    }
    const host = parsed.hostname.toLowerCase();
    if (host === 'dev.azure.com') {
        const organization = parsed.pathname.split('/')[1];
        return organization ? decodeURIComponent(organization) : undefined;
    }
    const legacy = /^([a-z0-9-]+)\.visualstudio\.com$/.exec(host);
    return legacy?.[1];
}

/** Returns the protocol URL for an Azure DevOps image. Returns undefined when the URL is not an Azure DevOps API URL. */
export function azureImageUrl(source: string): string | undefined {
    if (!azureApiOrganization(source)) return undefined;
    return `${AZURE_IMAGE_SCHEME}://${HOST}/?url=${encodeURIComponent(source)}`;
}

/** Reads the Azure DevOps URL from a protocol URL. Returns undefined when the URL is not valid. */
export function parseAzureImageUrl(url: string): { url: string; organization: string } | undefined {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    if (parsed.protocol !== `${AZURE_IMAGE_SCHEME}:` || parsed.hostname.toLowerCase() !== HOST) {
        return undefined;
    }
    const source = parsed.searchParams.get('url');
    const organization = source ? azureApiOrganization(source) : undefined;
    return source && organization ? { url: source, organization } : undefined;
}
