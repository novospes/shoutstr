import { substackFetch } from './fetch.js';

function normalizePublicationUrl(publicationUrl) {
  const trimmed = publicationUrl.trim().replace(/\/$/, '');
  if (!trimmed.startsWith('http')) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

export function getPublicationOrigin(publicationUrl) {
  const url = new URL(normalizePublicationUrl(publicationUrl));
  return url.origin;
}

export async function resolveSubstackPublicationOrigin(savedUrl = '') {
  if (savedUrl?.trim()) {
    return getPublicationOrigin(savedUrl);
  }

  const profile = await substackFetch('https://substack.com', '/api/v1/user/profile/self');
  const primary = profile?.primaryPublication;
  if (primary?.subdomain) {
    return `https://${primary.subdomain}.substack.com`;
  }

  for (const entry of profile?.publicationUsers || []) {
    const pub = entry?.publication || entry;
    const subdomain = pub?.subdomain || entry?.subdomain;
    if (!subdomain) continue;
    if (entry?.role === 'admin' || entry?.public !== false) {
      return `https://${subdomain}.substack.com`;
    }
  }

  throw new Error('Log in to Substack in this browser and create a publication first');
}
