import { describe, expect, it, vi } from 'vitest';
import { azureImageUrl } from '@shared/azure-image-url';
import { createAzureImageHandler } from './azure-image-protocol';

const SOURCE = 'https://dev.azure.com/contoso/p/_apis/git/repositories/r/pullRequests/1/attachments/a.png';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function request(url = azureImageUrl(SOURCE)!, method = 'GET'): Request {
    return new Request(url, { method });
}

describe('createAzureImageHandler', () => {
    it('gets the image with the provider of the organization and keeps it', async () => {
        const fetchFile = vi.fn(async () => new Response(PNG, { headers: { 'Content-Type': 'application/octet-stream' } }));
        const handler = createAzureImageHandler(fetchFile);
        const response = await handler(request());
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
        await handler(request());
        expect(fetchFile).toHaveBeenCalledTimes(1);
        expect(fetchFile).toHaveBeenCalledWith('contoso', SOURCE, 'image/*');
    });

    it('refuses a response that is not an image', async () => {
        const handler = createAzureImageHandler(async () => new Response('{"a":1}', { headers: { 'Content-Type': 'application/json' } }));
        expect((await handler(request())).status).toBe(502);
    });

    it('tries again after a failure', async () => {
        const fetchFile = vi
            .fn()
            .mockRejectedValueOnce(new Error('No token'))
            .mockResolvedValueOnce(new Response(PNG, { headers: { 'Content-Type': 'image/png' } }));
        const handler = createAzureImageHandler(fetchFile);
        expect((await handler(request())).status).toBe(502);
        expect((await handler(request())).status).toBe(200);
    });

    it('refuses a URL that is not valid and a method that is not GET', async () => {
        const handler = createAzureImageHandler(vi.fn());
        expect((await handler(request('shipwarden-azure-image://image/?url=https%3A%2F%2Fexample.com%2Fa.png'))).status).toBe(400);
        expect((await handler(request(undefined, 'POST'))).status).toBe(405);
    });
});
