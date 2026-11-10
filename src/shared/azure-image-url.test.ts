import { describe, expect, it } from 'vitest';
import { azureApiOrganization, azureImageUrl, parseAzureImageUrl } from './azure-image-url';

const ATTACHMENT = 'https://dev.azure.com/contoso/0f3c/_apis/git/repositories/9a1b/pullRequests/12/attachments/image%20(2).png';

describe('azureApiOrganization', () => {
    it('reads the organization of an Azure DevOps API URL', () => {
        expect(azureApiOrganization(ATTACHMENT)).toBe('contoso');
        expect(azureApiOrganization('https://Fabrikam.visualstudio.com/0f3c/_apis/wit/attachments/1?fileName=a.png')).toBe('fabrikam');
    });

    it('refuses other URLs', () => {
        expect(azureApiOrganization('https://example.com/contoso/_apis/x.png')).toBeUndefined();
        expect(azureApiOrganization('https://dev.azure.com/contoso/project/_git/repo')).toBeUndefined();
        expect(azureApiOrganization('http://dev.azure.com/contoso/_apis/x.png')).toBeUndefined();
        expect(azureApiOrganization('https://user:pw@dev.azure.com/contoso/_apis/x.png')).toBeUndefined();
        expect(azureApiOrganization('https://dev.azure.com.example.com/contoso/_apis/x.png')).toBeUndefined();
        expect(azureApiOrganization('not a url')).toBeUndefined();
    });
});

describe('azureImageUrl', () => {
    it('makes a protocol URL that gives back the Azure DevOps URL', () => {
        const url = azureImageUrl(ATTACHMENT);
        expect(url).toMatch(/^shipwarden-azure-image:\/\/image\/\?url=/);
        expect(parseAzureImageUrl(url!)).toEqual({ url: ATTACHMENT, organization: 'contoso' });
    });

    it('returns undefined for an image that is not on Azure DevOps', () => {
        expect(azureImageUrl('https://example.com/a.png')).toBeUndefined();
    });
});

describe('parseAzureImageUrl', () => {
    it('refuses a protocol URL with a different host', () => {
        expect(parseAzureImageUrl('https://image/?url=x')).toBeUndefined();
        expect(parseAzureImageUrl(`shipwarden-azure-image://image/?url=${encodeURIComponent('https://example.com/_apis/a.png')}`)).toBeUndefined();
    });
});
