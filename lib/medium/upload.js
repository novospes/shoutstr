import { mediumImageHref } from './file_id.js';

export async function verifyMediumCdnImage(fileId, retries = 4) {
  const href = mediumImageHref(fileId);
  if (!href) return false;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
    try {
      const response = await fetch(href, { method: 'GET', redirect: 'follow' });
      if (!response.ok) continue;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.startsWith('image/')) {
        return true;
      }
    } catch {
      /* retry */
    }
  }

  return false;
}
