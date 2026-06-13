import { encodeArrayBuffer } from '../lib/message_buffer.js';

const EDITOR_URL = chrome.runtime.getURL('editor/editor.html');

const SUBSTACK_ORIGINS = ['https://substack.com', 'https://www.substack.com'];

async function getSubstackCookieHeader(publicationOrigin) {
  const origins = [...new Set([...SUBSTACK_ORIGINS, publicationOrigin])];
  const seen = new Set();
  const parts = [];

  for (const origin of origins) {
    const cookies = await chrome.cookies.getAll({ url: `${origin}/` });
    for (const cookie of cookies) {
      if (seen.has(cookie.name)) continue;
      seen.add(cookie.name);
      parts.push(`${cookie.name}=${cookie.value}`);
    }
  }

  return parts.join('; ');
}

async function substackRequest(publicationOrigin, path, options = {}) {
  const url = `${publicationOrigin}${path}`;
  const cookieHeader = await getSubstackCookieHeader(publicationOrigin);

  const headers = {
    Accept: 'application/json',
    ...options.headers,
  };

  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    credentials: 'include',
    headers,
    body: options.body,
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.error || data?.msg || text || response.statusText;
    if (response.status === 401 || response.status === 403) {
      throw new Error('Please log in to Substack first (open substack.com in this browser)');
    }
    throw new Error(message || `Substack request failed (${response.status})`);
  }

  return data;
}

function normalizeImageMimeType(contentType, filename = 'image.jpg') {
  const raw = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (raw.startsWith('image/')) return raw;

  const ext = filename.split('.').pop()?.toLowerCase();
  const byExt = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  return byExt[ext] || 'image/jpeg';
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function extractUploadedImageUrl(data) {
  return data?.url
    || data?.imageUrl
    || data?.src
    || data?.uploadURL
    || data?.attachment?.imageUrl
    || data?.attachment?.url
    || '';
}

async function substackUploadImageJson(publicationOrigin, buffer, filename = 'image.jpg', contentType = '') {
  const mimeType = normalizeImageMimeType(contentType, filename);
  const dataUri = `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`;

  const data = await substackRequest(publicationOrigin, '/api/v1/image', {
    method: 'POST',
    body: JSON.stringify({ image: dataUri }),
  });

  const uploadedUrl = extractUploadedImageUrl(data);
  if (!uploadedUrl) {
    throw new Error('Substack image upload succeeded but returned no URL');
  }

  return { ...data, url: uploadedUrl };
}

async function substackUploadImageRequest(publicationOrigin, imageUrl, filename = 'image.jpg') {
  const response = await fetch(imageUrl, { credentials: 'omit' });
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const mimeType = response.headers.get('content-type') || '';
  return substackUploadImageJson(publicationOrigin, buffer, filename, mimeType);
}

async function fetchImageBuffer(imageUrl) {
  const response = await fetch(imageUrl, { credentials: 'omit' });
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const mimeType = response.headers.get('content-type') || 'image/jpeg';
  return { bytes: encodeArrayBuffer(buffer), mimeType };
}

function respond(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch {
    /* listener may have gone away */
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ping') {
    respond(sendResponse, { ok: true });
    return true;
  }

  if (message.type === 'fetch-image') {
    fetchImageBuffer(message.url)
      .then((result) => respond(sendResponse, result))
      .catch((error) => respond(sendResponse, { error: error.message }));
    return true;
  }

  if (message.type === 'substack-fetch') {
    substackRequest(message.publicationOrigin, message.path, message.options)
      .then((data) => respond(sendResponse, { data }))
      .catch((error) => respond(sendResponse, { error: error.message }));
    return true;
  }

  if (message.type === 'substack-upload-image') {
    substackUploadImageRequest(
      message.publicationOrigin,
      message.imageUrl,
      message.filename,
    )
      .then((data) => respond(sendResponse, { data }))
      .catch((error) => respond(sendResponse, { error: error.message }));
    return true;
  }

  return false;
});

async function openEditor() {
  const tabs = await chrome.tabs.query({ url: EDITOR_URL });

  if (tabs.length > 0) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return;
  }

  await chrome.tabs.create({ url: EDITOR_URL });
}

chrome.action.onClicked.addListener(() => {
  openEditor().catch(() => {});
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.storage.local.get(['nostrRelays'], (settings) => {
    const updates = {};
    if (!settings.nostrRelays) {
      updates.nostrRelays = [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.nostr.band',
      ];
    }
    if (Object.keys(updates).length > 0) {
      chrome.storage.local.set(updates);
    }
  });

  if (reason === 'install') {
    openEditor().catch(() => {});
  }
});
