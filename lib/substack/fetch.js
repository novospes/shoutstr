function runtimeSendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function runtimeSendMessageWithRetry(message, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await runtimeSendMessage(message);
    } catch (error) {
      lastError = error;
      const retryable = error.message.includes('message port closed')
        || error.message.includes('Receiving end does not exist');
      if (!retryable || attempt === retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw lastError;
}

function parseRuntimeResponse(response) {
  if (response?.error) {
    throw new Error(response.error);
  }
  return response?.data;
}

export function substackFetch(publicationOrigin, path, options = {}) {
  return runtimeSendMessageWithRetry({
    type: 'substack-fetch',
    publicationOrigin,
    path,
    options: {
      method: options.method || 'GET',
      body: options.body,
      headers: options.headers,
    },
  }).then(parseRuntimeResponse);
}

export async function substackUploadImage(
  publicationOrigin,
  imageUrl,
  filename = 'image.jpg',
) {
  const response = await runtimeSendMessageWithRetry({
    type: 'substack-upload-image',
    publicationOrigin,
    imageUrl,
    filename,
  });
  return parseRuntimeResponse(response);
}
