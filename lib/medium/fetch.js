import { fetchImagePayload } from '../image_handler.js';
import { bytesToBase64 } from '../message_buffer.js';
import { normalizeMediumFileId, mediumImageHref } from './file_id.js';
import { buildMediumSavePayload } from './save_deltas.js';
import { verifyMediumCdnImage } from './upload.js';
import { mediumPublishStep } from './inpage.js';

const MEDIUM_COOKIE_URLS = [
  'https://medium.com/',
  'https://www.medium.com/',
];

const SESSION_COOKIE_NAMES = new Set(['sid', 'uid']);

async function getMediumSessionMeta() {
  const seen = new Set();
  const cookies = [];

  for (const url of MEDIUM_COOKIE_URLS) {
    const batch = await chrome.cookies.getAll({ url });
    for (const cookie of batch) {
      if (seen.has(cookie.name)) continue;
      seen.add(cookie.name);
      cookies.push(cookie);
    }
  }

  const domainCookies = await chrome.cookies.getAll({ domain: '.medium.com' });
  for (const cookie of domainCookies) {
    if (seen.has(cookie.name)) continue;
    seen.add(cookie.name);
    cookies.push(cookie);
  }

  const xsrf = cookies.find((cookie) => cookie.name === 'xsrf')?.value || '';
  const hasSession = cookies.some(
    (cookie) => SESSION_COOKIE_NAMES.has(cookie.name) && cookie.value,
  );

  return { xsrf, hasSession };
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('Timed out waiting for medium.com to load'));
    }, timeoutMs);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    });
  });
}

async function ensureMediumTabId() {
  const tabs = await chrome.tabs.query({
    url: ['https://medium.com/*', 'https://www.medium.com/*'],
  });

  const preferred = tabs.find((tab) => {
    const url = tab.url || '';
    return url.includes('medium.com') && !url.includes('/m/signin');
  });

  if (preferred?.id) return preferred.id;
  if (tabs[0]?.id) return tabs[0].id;

  const tab = await chrome.tabs.create({ url: 'https://medium.com/', active: false });
  await waitForTabComplete(tab.id);
  return tab.id;
}

function collectImageUrlsFromDeltas(deltas) {
  const urls = new Set();
  for (const delta of deltas) {
    const sourceUrl = delta?.paragraph?.metadata?._sourceUrl;
    if (sourceUrl) urls.add(sourceUrl);
  }
  return [...urls];
}

function applyImageUploads(deltas, uploadsByUrl) {
  const resolved = JSON.parse(JSON.stringify(deltas));

  for (const delta of resolved) {
    const metadata = delta?.paragraph?.metadata;
    const sourceUrl = metadata?._sourceUrl;
    if (!sourceUrl) continue;

    const uploaded = uploadsByUrl[sourceUrl];
    if (!uploaded) {
      throw new Error(`Image upload missing for ${sourceUrl}`);
    }

    const fileId = normalizeMediumFileId(uploaded.fileId, {
      mimeType: uploaded.mimeType,
      sourceUrl,
    }) || normalizeMediumFileId(uploaded.imageId, {
      mimeType: uploaded.mimeType,
      sourceUrl,
    });

    if (!fileId) {
      throw new Error(`Medium image upload missing file id for ${sourceUrl}`);
    }

    delta.paragraph.metadata = {
      id: fileId,
      originalWidth: uploaded.width,
      originalHeight: uploaded.height,
      alt: metadata.alt ?? null,
    };
    delta.paragraph.href = mediumImageHref(fileId);
    delete delta.paragraph.iframe;
    if (metadata.isFeatured) {
      delta.paragraph.metadata.isFeatured = true;
    }
  }

  return resolved;
}

async function runMediumStep(tabId, step, payload) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: mediumPublishStep,
    args: [step, payload],
  });

  const result = injection?.result;
  if (!result) {
    throw new Error(`Medium ${step} returned no result`);
  }
  if (result.error) {
    throw new Error(result.error);
  }
  return result;
}

const BASE64_CHUNK_CHARS = 200_000;

async function ensureInpageUploadScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['lib/medium/inpage_upload.js'],
  });
}

async function runInPageImageUpload(tabId, postId, xsrfToken, sourceUrl, bytePayload) {
  await ensureInpageUploadScript(tabId);
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (postIdArg, sourceUrlArg, xsrfArg, payload) => {
      const upload = window.__shoutstrMediumUploadImageBytes;
      if (typeof upload !== 'function') {
        return { error: 'Medium in-page upload helper not loaded' };
      }
      return upload(postIdArg, sourceUrlArg, xsrfArg, payload);
    },
    args: [postId, sourceUrl, xsrfToken, bytePayload],
  });

  if (!injection) {
    throw new Error('Medium in-page script injection returned no frame result');
  }
  return injection.result;
}

async function runInPageImageUploadWithBytes(
  tabId,
  postId,
  xsrfToken,
  sourceUrl,
  imagePayload,
) {
  const base64 = bytesToBase64(imagePayload.bytes);

  if (base64.length <= BASE64_CHUNK_CHARS) {
    return runInPageImageUpload(tabId, postId, xsrfToken, sourceUrl, {
      base64,
      mimeType: imagePayload.mimeType,
      filename: imagePayload.filename,
      width: imagePayload.width,
      height: imagePayload.height,
    });
  }

  const sessionId = `shoutstr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const totalChunks = Math.ceil(base64.length / BASE64_CHUNK_CHARS);
  const meta = {
    postId,
    sourceUrl,
    xsrfToken,
    mimeType: imagePayload.mimeType,
    filename: imagePayload.filename,
    width: imagePayload.width,
    height: imagePayload.height,
  };

  let lastResult = null;
  await ensureInpageUploadScript(tabId);
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const chunkText = base64.slice(
      chunkIndex * BASE64_CHUNK_CHARS,
      (chunkIndex + 1) * BASE64_CHUNK_CHARS,
    );
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (sessionIdArg, index, total, chunk, metaArg) => {
        const uploadChunk = window.__shoutstrMediumUploadImageChunk;
        if (typeof uploadChunk !== 'function') {
          return { error: 'Medium in-page chunk upload helper not loaded' };
        }
        return uploadChunk(sessionIdArg, index, total, chunk, metaArg);
      },
      args: [
        sessionId,
        chunkIndex,
        totalChunks,
        chunkText,
        chunkIndex === totalChunks - 1 ? meta : null,
      ],
    });
    if (!injection) {
      throw new Error('Medium in-page chunk injection returned no frame result');
    }
    lastResult = injection.result;
    if (lastResult?.error) return lastResult;
  }

  return lastResult;
}

async function uploadMediumImage(tabId, postId, xsrfToken, sourceUrl) {
  const imagePayload = await fetchImagePayload(sourceUrl);
  const result = await runInPageImageUploadWithBytes(
    tabId,
    postId,
    xsrfToken,
    sourceUrl,
    imagePayload,
  );

  if (!result || result.error) {
    throw new Error(result?.error || 'Medium in-page image upload returned no result');
  }

  const responseMimeType = result.mimeType || 'image/jpeg';
  const fileId = normalizeMediumFileId(result.fileId, {
    mimeType: responseMimeType,
    sourceUrl,
  }) || normalizeMediumFileId(result.imageId, {
    mimeType: responseMimeType,
    sourceUrl,
  });

  if (!fileId) {
    throw new Error(`Medium image upload returned no file id for ${sourceUrl}`);
  }

  const cdnOk = await verifyMediumCdnImage(fileId);
  if (!cdnOk) {
    throw new Error(`Image not available on Medium CDN after upload (${fileId})`);
  }

  return {
    imageId: result.imageId || fileId,
    fileId,
    mimeType: responseMimeType,
    width: result.width || 1200,
    height: result.height || 630,
  };
}

async function saveDeltasInPage(tabId, postId, xsrfToken, contentDeltas) {
  const savePayload = buildMediumSavePayload(postId, contentDeltas);
  return runMediumStep(tabId, 'save-deltas', {
    xsrfToken,
    postId,
    savePayload,
  });
}

export async function mediumSessionPublish({ deltas, onProgress }) {
  const session = await getMediumSessionMeta();
  if (!session.hasSession) {
    throw new Error('Please log in to Medium first (open medium.com in this browser)');
  }

  if (!Array.isArray(deltas) || deltas.length === 0) {
    throw new Error('Medium draft has no content to save');
  }

  onProgress?.('Connecting to Medium…');
  const tabId = await ensureMediumTabId();

  onProgress?.('Creating draft…');
  const createResult = await runMediumStep(tabId, 'create', { xsrfToken: session.xsrf });
  const { postId } = createResult;
  const draftEditUrl = `https://medium.com/p/${postId}/edit`;

  onProgress?.('Opening draft editor…');
  await chrome.tabs.update(tabId, { url: draftEditUrl });
  await waitForTabComplete(tabId);

  const imageUrls = collectImageUrlsFromDeltas(deltas);
  const uploadsByUrl = {};

  for (let i = 0; i < imageUrls.length; i += 1) {
    const sourceUrl = imageUrls[i];
    onProgress?.(`Uploading image ${i + 1}/${imageUrls.length}…`);
    uploadsByUrl[sourceUrl] = await uploadMediumImage(tabId, postId, session.xsrf, sourceUrl);
  }

  onProgress?.('Saving draft…');
  const resolvedDeltas = imageUrls.length > 0
    ? applyImageUploads(deltas, uploadsByUrl)
    : deltas;

  await saveDeltasInPage(tabId, postId, session.xsrf, resolvedDeltas);

  onProgress?.('Publishing…');
  try {
    const { url } = await runMediumStep(tabId, 'publish', {
      xsrfToken: session.xsrf,
      postId,
    });
    return { url };
  } catch (publishError) {
    if (/rate limit/i.test(publishError.message || '')) {
      return {
        url: draftEditUrl,
        draftOnly: true,
        message: publishError.message,
      };
    }
    throw publishError;
  }
}
