import { schnorr, utils } from '../../vendor/noble-secp256k1.js';

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= generators[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const ret = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function bech32CreateChecksum(hrp, data) {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const polymod = bech32Polymod(values) ^ 1;
  const ret = [];
  for (let p = 0; p < 6; p++) ret.push((polymod >> (5 * (5 - p))) & 31);
  return ret;
}

function bech32Decode(str) {
  if (str.length < 8 || str.length > 90) throw new Error('Invalid bech32 string');
  const lowered = str.toLowerCase();
  if (str !== lowered && str !== str.toUpperCase()) throw new Error('Mixed-case bech32');
  const pos = lowered.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lowered.length) throw new Error('Invalid bech32 separator');
  const hrp = lowered.slice(0, pos);
  const data = [];
  for (let i = pos + 1; i < lowered.length; i++) {
    const idx = BECH32_CHARSET.indexOf(lowered[i]);
    if (idx === -1) throw new Error('Invalid bech32 character');
    data.push(idx);
  }
  if (bech32Polymod(bech32HrpExpand(hrp).concat(data)) !== 1) {
    throw new Error('Invalid bech32 checksum');
  }
  return { hrp, data: data.slice(0, -6) };
}

function convertBits(data, fromBits, toBits, pad = true) {
  let acc = 0;
  let bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    throw new Error('Invalid padding in convertBits');
  }
  return ret;
}

export function decodeNsec(nsec) {
  const trimmed = nsec.trim();
  if (!trimmed.startsWith('nsec1')) throw new Error('Invalid Nostr private key');
  const { hrp, data } = bech32Decode(trimmed);
  if (hrp !== 'nsec') throw new Error('Invalid Nostr private key');
  const bytes = convertBits(data, 5, 8, false);
  if (bytes.length !== 32) throw new Error('Invalid Nostr private key');
  return new Uint8Array(bytes);
}

export function getPublicKeyHex(privateKeyBytes) {
  const pubkey = schnorr.getPublicKey(privateKeyBytes);
  return bytesToHex(pubkey);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function sha256Hex(data) {
  const encoded = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(new Uint8Array(hash));
}

export function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'article';
}

/** NIP-98 HTTP auth — returns `Authorization` header value for a request. */
export async function createNip98AuthorizationHeader({ url, method, privateKeyBytes }) {
  if (!utils.isValidPrivateKey(privateKeyBytes)) {
    throw new Error('Invalid Nostr private key');
  }

  const pubkey = getPublicKeyHex(privateKeyBytes);
  const created_at = Math.floor(Date.now() / 1000);
  const tags = [
    ['u', url],
    ['method', method.toUpperCase()],
  ];

  const unsigned = {
    kind: 27235,
    created_at,
    tags,
    content: '',
    pubkey,
  };

  const serialized = JSON.stringify([
    0,
    pubkey,
    unsigned.created_at,
    unsigned.kind,
    unsigned.tags,
    unsigned.content,
  ]);

  const id = await sha256Hex(serialized);
  const idBytes = hexToBytes(id);
  const sigBytes = await schnorr.sign(idBytes, privateKeyBytes);
  const sig = bytesToHex(sigBytes);

  const signedEvent = { ...unsigned, id, sig };
  return `Nostr ${btoa(JSON.stringify(signedEvent))}`;
}

export async function signNostrEvent(event) {
  if (!utils.isValidPrivateKey(event.privateKeyBytes)) {
    throw new Error('Invalid Nostr private key');
  }

  const pubkey = getPublicKeyHex(event.privateKeyBytes);
  const unsigned = {
    kind: event.kind,
    created_at: event.created_at,
    tags: event.tags,
    content: event.content,
    pubkey,
  };

  const serialized = JSON.stringify([
    0,
    pubkey,
    unsigned.created_at,
    unsigned.kind,
    unsigned.tags,
    unsigned.content,
  ]);

  const id = await sha256Hex(serialized);
  const idBytes = hexToBytes(id);
  const sigBytes = await schnorr.sign(idBytes, event.privateKeyBytes);
  const sig = bytesToHex(sigBytes);

  return { ...unsigned, id, sig };
}
