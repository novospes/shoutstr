function extensionFromMimeOrUrl(mimeType, sourceUrl) {
  const byMime = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };

  if (mimeType && byMime[mimeType]) return byMime[mimeType];

  try {
    const ext = new URL(sourceUrl).pathname.split('.').pop()?.toLowerCase() || '';
    if (ext === 'jpeg') return 'jpg';
    if (/^(jpg|png|webp|gif)$/.test(ext)) return ext;
  } catch {
    /* ignore */
  }

  return 'jpg';
}

function hasFileExtension(value) {
  const base = String(value).split('?')[0].split('#')[0];
  return /\.[a-z0-9]{2,5}$/i.test(base);
}

export function normalizeMediumFileId(value, { mimeType = '', sourceUrl = '' } = {}) {
  if (!value) return null;
  let text = String(value).trim();
  if (!text) return null;

  if (text.startsWith('0*')) {
    text = `1*${text.slice(2)}`;
  } else if (!/^\d+\*/.test(text)) {
    text = `1*${text}`;
  }

  if (!hasFileExtension(text)) {
    text = `${text}.${extensionFromMimeOrUrl(mimeType, sourceUrl)}`;
  }

  return text;
}

export function hashFromMediumFileId(value) {
  if (!value) return null;
  const text = String(value);
  const hashMatch = text.match(/(?:\d\*|0\*)([^./?&#]+)/);
  if (hashMatch?.[1]) return hashMatch[1];
  return text.replace(/\?.*$/, '').replace(/\.[^.]+$/, '') || null;
}

export function mediumImageHref(fileId) {
  if (!fileId) return null;
  return `https://cdn-images-1.medium.com/v2/resize:fit:1600/${fileId}`;
}
