/* global window */
(function registerShoutstrMediumUpload() {
  const DASHBOARD = 'https://medium.com';

  function readCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : '';
  }

  function parseMediumJson(text) {
    if (text.startsWith('])}')) {
      const stripped = text.includes('\n') ? text.split('\n').slice(1).join('\n') : text.slice(16);
      return JSON.parse(stripped);
    }
    return JSON.parse(text);
  }

  function mediumResponseHasError(parsed) {
    if (!parsed || typeof parsed !== 'object') return false;
    if (parsed.success === false) return true;
    if (parsed.error) return true;
    if (parsed.errors?.length) return true;
    return false;
  }

  function mediumResponseErrorMessage(parsed, text, status) {
    return parsed?.error
      || parsed?.message
      || parsed?.raw
      || (typeof text === 'string' && text.slice(0, 500))
      || `HTTP ${status}`;
  }

  function extractUploadTarget(data) {
    if (typeof data === 'string' && /\d+\*/.test(data)) {
      return {
        uploadUrl: null,
        fileId: data,
        imageId: data.replace(/^\d+\*/, ''),
        width: null,
        height: null,
        mimeType: null,
      };
    }

    const candidates = [
      data,
      data?.payload,
      data?.payload?.value,
      data?.value,
      data?.data,
      data?.uploadedFile,
      data?.payload?.uploadedFile,
    ];
    let uploadUrl = null;
    let fileId = null;
    let imageId = null;
    let width = null;
    let height = null;
    let mimeType = null;

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      uploadUrl = uploadUrl || candidate.uploadUrl || candidate.upload_url || null;
      fileId = fileId || candidate.fileId || candidate.file_id || null;
      imageId = imageId
        || candidate.imageId
        || candidate.image_id
        || candidate.id
        || candidate.md5
        || candidate.hash
        || null;
      width = width
        || candidate.imgWidth
        || candidate.originalWidth
        || candidate.width
        || null;
      height = height
        || candidate.imgHeight
        || candidate.originalHeight
        || candidate.height
        || null;
      mimeType = mimeType || candidate.mimeType || candidate.contentType || null;
    }

    return {
      uploadUrl: uploadUrl || null,
      fileId: fileId ? String(fileId) : null,
      imageId: imageId ? String(imageId) : null,
      width: width || null,
      height: height || null,
      mimeType: mimeType || null,
    };
  }

  function mediumEditorHeaders(referer, xsrfToken, json = false) {
    const xsrf = xsrfToken || readCookie('xsrf');
    const headers = {
      Accept: 'application/json',
      Origin: DASHBOARD,
      Referer: referer,
      'X-Obvious-CID': 'web',
      'X-Client-Date': String(Date.now()),
    };
    if (json) headers['Content-Type'] = 'application/json';
    if (xsrf) headers['x-xsrf-token'] = xsrf;
    return headers;
  }

  function jsonHeaders(referer, xsrfToken) {
    return mediumEditorHeaders(referer, xsrfToken, true);
  }

  function multipartHeaders(referer) {
    return {
      Accept: '*/*',
      Origin: DASHBOARD,
      Referer: referer,
      'X-Obvious-CID': 'web',
      'x-xsrf-token': '1',
    };
  }

  async function tryEditorUpload(postId, blob, filename, xsrfToken) {
    const referer = `${DASHBOARD}/p/${postId}/edit`;
    const safeName = filename || 'image.jpg';
    const sourceValues = ['6'];
    let lastError = null;

    for (const source of sourceValues) {
      try {
        const formData = new FormData();
        formData.append('uploadedFile', blob, safeName);

        const response = await fetch(`${DASHBOARD}/_/upload?source=${encodeURIComponent(source)}`, {
          method: 'POST',
          credentials: 'include',
          headers: multipartHeaders(referer),
          body: formData,
        });

        const text = await response.text();
        let parsed;
        try {
          parsed = text ? parseMediumJson(text) : {};
        } catch {
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            parsed = { raw: text };
          }
        }

        if (!response.ok || mediumResponseHasError(parsed)) {
          throw new Error(mediumResponseErrorMessage(parsed, text, response.status));
        }

        const target = extractUploadTarget(parsed);
        if (!target.fileId && !target.imageId) {
          throw new Error('Medium editor upload returned no image id');
        }

        return {
          ...target,
          mimeType: target.mimeType || blob.type || 'image/jpeg',
          method: 'inpage-editor-upload',
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Medium editor upload failed');
  }

  function fileIdFromV1Response(parsed) {
    const md5 = parsed?.data?.md5 || parsed?.md5 || null;
    if (md5) return `0*${md5}`;

    const url = parsed?.data?.url || parsed?.url || '';
    if (!url) return null;
    const hashMatch = url.match(/(?:\d\*|0\*)([^./?&#]+)/);
    if (hashMatch?.[1]) return `0*${hashMatch[1]}`;
    const lastSegment = url.split('/').pop() || '';
    const base = lastSegment.replace(/\?.*$/, '').replace(/\.[^.]+$/, '');
    return base ? `0*${base}` : null;
  }

  async function tryV1ImagesUpload(postId, blob, filename, xsrfToken) {
    const referer = `${DASHBOARD}/p/${postId}/edit`;
    const safeName = filename || 'image.jpg';
    const formData = new FormData();
    formData.append('image', blob, safeName);

    const response = await fetch('https://api.medium.com/v1/images', {
      method: 'POST',
      credentials: 'include',
      headers: mediumEditorHeaders(referer, xsrfToken, false),
      body: formData,
    });

    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    if (!response.ok || parsed?.errors?.length) {
      throw new Error(
        parsed?.errors?.[0]?.message
        || parsed?.error
        || parsed?.raw
        || text
        || `v1/images failed (${response.status})`,
      );
    }

    const fileId = fileIdFromV1Response(parsed);
    if (!fileId) {
      throw new Error('Medium v1/images returned no image id');
    }

    return {
      fileId,
      imageId: fileId.replace(/^0\*/, ''),
      mimeType: blob.type || 'image/jpeg',
      method: 'inpage-v1-images',
    };
  }

  async function loadImageBlob(sourceUrl, bytePayload) {
    if (bytePayload?.base64) {
      const binary = atob(bytePayload.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new Blob([bytes], { type: bytePayload.mimeType || 'image/jpeg' });
    }

    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }
    return response.blob();
  }

  async function putBlobToUploadUrl(uploadUrl, blob) {
    const putResponse = await fetch(uploadUrl, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': blob.type || 'image/jpeg' },
    });
    if (!putResponse.ok) {
      throw new Error(`Medium image byte upload failed (${putResponse.status})`);
    }
  }

  async function tryJsonUploadWithUrl(postId, sourceUrl, blob, filename, xsrfToken) {
    const referer = `${DASHBOARD}/p/${postId}/edit`;
    const contentType = blob.type || 'image/jpeg';
    const safeName = filename || 'image.jpg';
    const requestBodies = [
      { url: sourceUrl, postId, contentType, fileName: safeName },
      { url: sourceUrl, postId, contentType, filename: safeName },
      { url: sourceUrl, postId, mimeType: contentType, fileName: safeName },
      { url: sourceUrl, postId },
      { url: sourceUrl },
    ];
    let lastError = null;

    for (const body of requestBodies) {
      try {
        const response = await fetch(`${DASHBOARD}/_/upload-url`, {
          method: 'POST',
          credentials: 'include',
          headers: jsonHeaders(referer, xsrfToken),
          body: JSON.stringify(body),
        });
        const text = await response.text();
        let parsed;
        try {
          parsed = text ? parseMediumJson(text) : {};
        } catch {
          parsed = { raw: text };
        }
        if (!response.ok || mediumResponseHasError(parsed)) {
          throw new Error(mediumResponseErrorMessage(parsed, text, response.status));
        }
        const target = extractUploadTarget(parsed);
        if (target.uploadUrl) {
          await putBlobToUploadUrl(target.uploadUrl, blob);
          return { ...target, method: 'inpage-json-url-presigned' };
        }
        throw new Error('Medium JSON url upload returned no presigned URL');
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Medium JSON url upload failed');
  }

  async function uploadImageBytes(postId, sourceUrl, xsrfToken, bytePayload) {
    const normalizedUrl = String(sourceUrl || '').trim();

    if (!postId) return { error: 'Medium image upload missing post ID' };
    if (!normalizedUrl) return { error: 'Medium image upload missing source URL' };

    let blob;
    try {
      blob = await loadImageBlob(normalizedUrl, bytePayload);
    } catch (error) {
      return { error: error.message || 'Failed to load image bytes' };
    }

    const filename = bytePayload?.filename || normalizedUrl.split('/').pop() || 'image.jpg';
    const fallbackWidth = bytePayload?.width || 1200;
    const fallbackHeight = bytePayload?.height || 630;
    const errors = [];
    let target = null;

    try {
      target = await tryEditorUpload(postId, blob, filename, xsrfToken);
    } catch (error) {
      errors.push(error.message || 'editor upload failed');
    }

    if (!target) {
      try {
        target = await tryV1ImagesUpload(postId, blob, filename, xsrfToken);
      } catch (error) {
        errors.push(error.message || 'v1/images upload failed');
      }
    }

    if (!target) {
      try {
        target = await tryJsonUploadWithUrl(postId, normalizedUrl, blob, filename, xsrfToken);
      } catch (error) {
        errors.push(error.message || 'json url upload failed');
      }
    }

    if (!target) {
      return { error: [...new Set(errors.filter(Boolean))].join('; ') || 'Medium image upload failed' };
    }

    return {
      fileId: target.fileId,
      imageId: target.imageId,
      mimeType: target.mimeType || blob.type || bytePayload?.mimeType || 'image/jpeg',
      width: target.width || fallbackWidth,
      height: target.height || fallbackHeight,
      method: target.method,
    };
  }

  window.__shoutstrMediumUploadImageBytes = async function shoutstrMediumUploadImageBytes(
    postId,
    sourceUrl,
    xsrfToken,
    bytePayload,
  ) {
    try {
      return await uploadImageBytes(postId, sourceUrl, xsrfToken, bytePayload);
    } catch (error) {
      return { error: error.message || 'Medium in-page image upload failed' };
    }
  };

  window.__shoutstrMediumUploadImageChunk = async function shoutstrMediumUploadImageChunk(
    sessionId,
    chunkIndex,
    totalChunks,
    chunkText,
    meta,
  ) {
    try {
      const store = window.__shoutstrImageUpload || (window.__shoutstrImageUpload = {});
      if (!store[sessionId]) {
        store[sessionId] = { parts: new Array(totalChunks), meta: null };
      }
      store[sessionId].parts[chunkIndex] = chunkText;
      if (meta) store[sessionId].meta = meta;

      if (chunkIndex !== totalChunks - 1) {
        return { waiting: true, chunkIndex, totalChunks };
      }

      const session = store[sessionId];
      delete store[sessionId];
      const base64 = session.parts.join('');
      const {
        postId,
        sourceUrl,
        xsrfToken,
        mimeType,
        filename,
        width,
        height,
      } = session.meta || {};

      return await uploadImageBytes(postId, sourceUrl, xsrfToken, {
        base64,
        mimeType,
        filename,
        width,
        height,
      });
    } catch (error) {
      return { error: error.message || 'Medium in-page chunked upload failed' };
    }
  };
}());
