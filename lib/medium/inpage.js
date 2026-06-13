// Runs in medium.com page context (MAIN world) via chrome.scripting.executeScript.

export async function mediumPublishStep(step, payload = {}) {
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

  function sessionHeaders(referer = `${DASHBOARD}/`, json = true, xsrfToken = '') {
    const xsrf = xsrfToken || readCookie('xsrf');
    const headers = { Accept: 'application/json' };
    if (json) headers['Content-Type'] = 'application/json';
    if (xsrf) headers['x-xsrf-token'] = xsrf;
    if (referer) headers.Referer = referer;
    return headers;
  }

  async function mediumGraphql(operation, query, variables = {}, referer = `${DASHBOARD}/`, xsrfToken = '') {
    const headers = sessionHeaders(referer, true, xsrfToken);
    headers['graphql-operation'] = operation;

    const response = await fetch(`${DASHBOARD}/_/graphql`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ operationName: operation, query, variables }),
    });

    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error('Medium returned an unexpected response');
    }

    if (!response.ok || body.errors?.length) {
      const message = body.errors?.[0]?.message || text || response.statusText;
      if (response.status === 401 || response.status === 403) {
        throw new Error('Please log in to Medium first (open medium.com in this browser)');
      }
      throw new Error(message || `Medium request failed (${response.status})`);
    }

    return body.data || {};
  }

  async function mediumUpdateDraftDeltas(postId, deltaPayload, xsrfToken = '') {
    const referer = `${DASHBOARD}/p/${postId}/edit`;
    const lockId = String(Math.floor(1000 + Math.random() * 9000));

    const headers = sessionHeaders(referer, true, xsrfToken);
    headers['X-Obvious-CID'] = 'web';
    headers['X-Client-Date'] = String(Date.now());

    const response = await fetch(`${DASHBOARD}/p/${postId}/deltas?logLockId=${lockId}`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(deltaPayload),
    });

    const text = await response.text();
    let body;
    try {
      body = text ? parseMediumJson(text) : {};
    } catch {
      body = { raw: text };
    }

    const saved = response.ok
      && body.success !== false
      && !body.error
      && (body.payload?.value || body.success === true || text.includes('"success":true'));

    if (!saved) {
      const message = body.error || body.message || body.raw || text || response.statusText;
      if (response.status === 401 || response.status === 403) {
        throw new Error('Please log in to Medium first (open medium.com in this browser)');
      }
      throw new Error(message || `Medium draft save failed (${response.status})`);
    }

    return body;
  }

  try {
    const xsrfToken = payload.xsrfToken || '';

    if (step === 'create') {
      const createData = await mediumGraphql(
        'CreatePostMutation',
        `mutation CreatePostMutation($input: CreatePostInput!) {
          createPost(input: $input) {
            id
            mediumUrl
          }
        }`,
        { input: {} },
        `${DASHBOARD}/`,
        xsrfToken,
      );

      const postId = createData?.createPost?.id;
      if (!postId) throw new Error('Medium draft creation failed');

      return { postId, mediumUrl: createData?.createPost?.mediumUrl || '' };
    }

    if (step === 'save-deltas') {
      const { postId, savePayload } = payload;
      if (!postId) throw new Error('Medium draft save missing post ID');
      if (!savePayload?.deltas?.length) {
        throw new Error('Medium draft has no content to save');
      }

      await mediumUpdateDraftDeltas(postId, savePayload, xsrfToken);

      return { postId };
    }

    if (step === 'publish') {
      const { postId } = payload;
      if (!postId) throw new Error('Medium publish missing post ID');

      const publishData = await mediumGraphql(
        'PublishPostMutation',
        `mutation PublishPostMutation($postId: ID!) {
          publishPost(postId: $postId) {
            id
            mediumUrl
          }
        }`,
        { postId },
        `${DASHBOARD}/p/${postId}/edit`,
        xsrfToken,
      );

      const url = publishData?.publishPost?.mediumUrl;
      if (!url) throw new Error('Medium publish succeeded but no URL was returned');
      return { url, id: publishData.publishPost.id };
    }

    throw new Error(`Unknown Medium publish step: ${step}`);
  } catch (error) {
    return { error: error.message || 'Medium publish failed' };
  }
}
