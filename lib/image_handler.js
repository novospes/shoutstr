import {
  extractImageUrls,
  replaceImageUrl,
  filenameForImage,
  normalizeImageUrl,
} from './markdown.js';
import { decodeToBlob, encodeBlob } from './message_buffer.js';
import { createNip98AuthorizationHeader } from './nostr/crypto.js';

const NOSTR_BUILD_UPLOAD_URL = 'https://nostr.build/api/v2/upload/files';

function imageOriginPattern(imageUrl) {
  try {
    const url = new URL(imageUrl);
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return null;
  }
}

async function ensureImagePermissions(imageUrls) {
  const patterns = [...new Set(imageUrls.map(imageOriginPattern).filter(Boolean))];
  if (patterns.length === 0) return true;

  const hasAll = await chrome.permissions.contains({ origins: patterns });
  if (hasAll) return true;

  const granted = await chrome.permissions.request({ origins: patterns });
  if (!granted) {
    /* uploads may fall back to original URLs */
  }
  return granted;
}

export function collectPublishImageUrls(markdownContent, headerImage = '') {
  const headerUrl = headerImage ? normalizeImageUrl(headerImage) : '';
  return [...new Set([
    ...extractImageUrls(markdownContent),
    ...(headerUrl ? [headerUrl] : []),
  ])];
}

export async function ensurePublishImagePermissions(markdownContent, headerImage = '') {
  return ensureImagePermissions(collectPublishImageUrls(markdownContent, headerImage));
}

async function fetchImageBlobDirect(imageUrl) {
  const response = await fetch(imageUrl, { credentials: 'omit' });
  if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
  return response.blob();
}

async function fetchImageBlobViaBackground(imageUrl) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'fetch-image', url: imageUrl }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      if (!response?.bytes && !response?.buffer) {
        reject(new Error('Image fetch returned no data'));
        return;
      }
      try {
        resolve(decodeToBlob(response.bytes || response.buffer, response.mimeType || 'image/jpeg'));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function fetchImageBlob(imageUrl) {
  try {
    return await fetchImageBlobViaBackground(imageUrl);
  } catch (proxyError) {
    try {
      return await fetchImageBlobDirect(imageUrl);
    } catch (directError) {
      throw proxyError;
    }
  }
}

export function readImageDimensionsFromBytes(bytes, mimeType = '') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const type = mimeType.toLowerCase();

  if ((type.includes('png') || (u8[0] === 0x89 && u8[1] === 0x50)) && u8.length >= 24) {
    const width = (u8[16] << 24) | (u8[17] << 16) | (u8[18] << 8) | u8[19];
    const height = (u8[20] << 24) | (u8[21] << 16) | (u8[22] << 8) | u8[23];
    if (width > 0 && height > 0) return { width, height };
  }

  if (type.includes('jpeg') || type.includes('jpg') || (u8[0] === 0xff && u8[1] === 0xd8)) {
    for (let i = 2; i < u8.length - 8; i += 1) {
      if (u8[i] !== 0xff) continue;
      const marker = u8[i + 1];
      if (marker === 0xc0 || marker === 0xc2) {
        const height = (u8[i + 5] << 8) | u8[i + 6];
        const width = (u8[i + 7] << 8) | u8[i + 8];
        if (width > 0 && height > 0) return { width, height };
      }
    }
  }

  if (type.includes('webp') && u8.length >= 30) {
    const width = u8[26] | (u8[27] << 8) | (u8[28] << 16);
    const height = u8[29] | (u8[30] << 8) | (u8[31] << 16);
    if (width > 0 && height > 0) return { width, height };
  }

  return { width: 1200, height: 630 };
}

export async function fetchImagePayload(imageUrl) {
  const blob = await fetchImageBlob(imageUrl);
  const encoded = await encodeBlob(blob);
  const dimensions = readImageDimensionsFromBytes(encoded.bytes, encoded.mimeType);
  return {
    bytes: encoded.bytes,
    mimeType: encoded.mimeType,
    filename: filenameForImage(blob, imageUrl),
    width: dimensions.width,
    height: dimensions.height,
  };
}

async function buildMediumImageUrlMap() {
  // Medium session publishing keeps public image URLs in the markdown body.
  return new Map();
}

async function buildSubstackImageUrlMap(imageUrls, publicationOrigin, onProgress) {
  const urlMap = new Map();
  if (!publicationOrigin || imageUrls.length === 0) return urlMap;

  const { substackUploadImage } = await import('./substack/fetch.js');

  for (let i = 0; i < imageUrls.length; i += 1) {
    const imageUrl = imageUrls[i];
    onProgress?.(`Uploading image ${i + 1}/${imageUrls.length}…`);

    try {
      const data = await substackUploadImage(
        publicationOrigin,
        imageUrl,
        filenameForImage(new Blob(), imageUrl),
      );
      const uploadedUrl = data?.url
        || data?.imageUrl
        || data?.src
        || data?.uploadURL
        || data?.attachment?.imageUrl
        || data?.attachment?.url
        || '';
      if (uploadedUrl) {
        urlMap.set(imageUrl, uploadedUrl);
      }
    } catch {
      /* keep original URL */
    }
  }

  return urlMap;
}

async function uploadToNostrBuild(blob, filename, privateKeyBytes) {
  if (!privateKeyBytes) {
    throw new Error('Nostr private key required for nostr.build image uploads');
  }

  const formData = new FormData();
  formData.append('file[]', blob, filename);

  const authorization = await createNip98AuthorizationHeader({
    url: NOSTR_BUILD_UPLOAD_URL,
    method: 'POST',
    privateKeyBytes,
  });

  const response = await fetch(NOSTR_BUILD_UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: authorization },
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`nostr.build upload failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const entry = data?.data?.[0] || data?.[0];
  return entry?.url || entry?.oxtag || data.url;
}

async function uploadImageForPlatform(imageUrl, blob, filename, platform, options = {}) {
  switch (platform) {
    case 'nostr':
      return uploadToNostrBuild(blob, filename, options.privateKeyBytes);
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

async function buildImageUrlMap(imageUrls, platform, options) {
  const urlMap = new Map();
  if (imageUrls.length === 0) return urlMap;

  await ensureImagePermissions(imageUrls);

  if (platform === 'substack') {
    return buildSubstackImageUrlMap(imageUrls, options.publicationOrigin, options.onProgress);
  }

  if (platform === 'medium') {
    return buildMediumImageUrlMap();
  }

  for (let i = 0; i < imageUrls.length; i += 1) {
    const imageUrl = imageUrls[i];
    options.onProgress?.(`Uploading image ${i + 1}/${imageUrls.length}…`);

    try {
      const blob = await fetchImageBlob(imageUrl);
      const filename = filenameForImage(blob, imageUrl);
      const newUrl = await uploadImageForPlatform(imageUrl, blob, filename, platform, options);
      if (newUrl) urlMap.set(imageUrl, newUrl);
    } catch {
      /* keep original URL */
    }
  }

  return urlMap;
}

function applyUrlMapToMarkdown(markdownContent, urlMap) {
  let processed = markdownContent;
  for (const [oldUrl, newUrl] of urlMap) {
    processed = replaceImageUrl(processed, oldUrl, newUrl);
  }
  return processed;
}

function applyUrlMapToHeader(headerImage, urlMap) {
  if (!headerImage) return '';
  const normalized = normalizeImageUrl(headerImage);
  return urlMap.get(normalized) || headerImage;
}

export async function processPublishImages(markdownContent, headerImage, platform, options = {}) {
  const headerUrl = headerImage ? normalizeImageUrl(headerImage) : '';
  const imageUrls = [...new Set([
    ...extractImageUrls(markdownContent),
    ...(headerUrl ? [headerUrl] : []),
  ])];

  const urlMap = await buildImageUrlMap(imageUrls, platform, options);

  return {
    markdown: applyUrlMapToMarkdown(markdownContent, urlMap),
    headerImage: applyUrlMapToHeader(headerImage, urlMap),
  };
}

export async function processImagesForPlatform(markdownContent, platform, options = {}) {
  const { markdown } = await processPublishImages(markdownContent, '', platform, options);
  return markdown;
}

export async function processHeaderImageForPlatform(headerImage, platform, options = {}) {
  if (!headerImage) return '';
  const { headerImage: processed } = await processPublishImages('', headerImage, platform, options);
  return processed;
}
