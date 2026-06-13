export function encodeArrayBuffer(arrayBuffer) {
  return Array.from(new Uint8Array(arrayBuffer));
}

function bytesToUint8Array(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return new Uint8Array(data);
  if (data && typeof data === 'object') {
    const length = typeof data.length === 'number' ? data.length : Object.keys(data).length;
    if (length > 0) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        bytes[i] = data[i] ?? 0;
      }
      return bytes;
    }
  }
  throw new Error('Invalid buffer payload');
}

export function decodeToBlob(data, mimeType = 'application/octet-stream') {
  if (data instanceof Blob) return data;
  return new Blob([bytesToUint8Array(data)], { type: mimeType });
}

export function decodeToFile(data, filename, mimeType = 'application/octet-stream') {
  if (data instanceof File) return data;
  return new File([bytesToUint8Array(data)], filename, { type: mimeType });
}

export async function encodeBlob(blob) {
  const buffer = await blob.arrayBuffer();
  return {
    bytes: encodeArrayBuffer(buffer),
    mimeType: blob.type || 'application/octet-stream',
  };
}

export function bytesToBase64(bytes) {
  const u8 = bytesToUint8Array(bytes);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < u8.length; i += chunkSize) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
