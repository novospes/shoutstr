import { processPublishImages } from '../image_handler.js';
import { decodeNsec, signNostrEvent, slugify } from './crypto.js';

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

function normalizeRelayUrl(url) {
  return url.trim().replace(/\/+$/, '');
}

function relayKey(relayUrl) {
  try {
    const url = new URL(normalizeRelayUrl(relayUrl));
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return null;
  }
}

async function ensureRelayPermissions(relays) {
  const patterns = relays.map(relayKey).filter(Boolean);
  if (patterns.length === 0) return;

  const granted = await chrome.permissions.contains({ origins: patterns });
  if (granted) return;

  const ok = await chrome.permissions.request({ origins: patterns });
  if (!ok) {
    throw new Error('Permission required to connect to custom Nostr relays');
  }
}

function publishToRelay(relayUrl, signedEvent, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws;
    let opened = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`Relay timeout: ${relayUrl}`));
    }, timeoutMs);

    try {
      ws = new WebSocket(relayUrl);
    } catch (error) {
      finish(reject, error);
      return;
    }

    ws.onopen = () => {
      opened = true;
      ws.send(JSON.stringify(['EVENT', signedEvent]));
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (!Array.isArray(message)) return;

        const [type, eventId, ok, reason] = message;
        if (type === 'OK' && eventId === signedEvent.id) {
          if (ok === true) {
            finish(resolve, { relay: relayUrl, ok: true });
          } else {
            finish(reject, new Error(reason || `Relay rejected event: ${relayUrl}`));
          }
        }
      } catch {
        /* ignore malformed messages */
      }
    };

    ws.onerror = () => {
      if (!opened) {
        finish(reject, new Error(`Could not connect to relay: ${relayUrl}`));
      }
    };

    ws.onclose = (event) => {
      if (!settled && !event.wasClean) {
        finish(
          reject,
          new Error(opened ? `Relay disconnected: ${relayUrl}` : `Could not connect to relay: ${relayUrl}`),
        );
      }
    };
  });
}

export async function publishToNostr({
  title,
  subtitle = '',
  tags,
  markdownContent,
  headerImage,
  nsec,
  relays = DEFAULT_RELAYS,
  onProgress,
}) {
  if (!nsec?.trim()) {
    throw new Error('Nostr private key (nsec) not set — add it in Settings');
  }

  onProgress?.('Preparing keys…');
  let privateKeyBytes;
  try {
    privateKeyBytes = decodeNsec(nsec);
  } catch {
    throw new Error('Invalid Nostr private key');
  }

  const relayList = (relays.length ? relays : DEFAULT_RELAYS)
    .map(normalizeRelayUrl)
    .filter(Boolean);
  onProgress?.('Checking relay permissions…');
  await ensureRelayPermissions(relayList);

  onProgress?.('Uploading images…');
  const { markdown: processedMarkdown, headerImage: processedHeader } = await processPublishImages(
    markdownContent,
    headerImage,
    'nostr',
    { privateKeyBytes, onProgress },
  );
  const createdAt = Math.floor(Date.now() / 1000);
  const identifier = `${slugify(title)}-${createdAt}`;

  const eventTags = [
    ['d', identifier],
    ['title', title],
    ['summary', subtitle || ''],
    ['published_at', String(createdAt)],
    ...tags.map((t) => ['t', t]),
  ];
  if (processedHeader) {
    eventTags.push(['image', processedHeader]);
  }

  onProgress?.('Signing article…');
  const signedEvent = await signNostrEvent({
    kind: 30023,
    created_at: createdAt,
    tags: eventTags,
    content: processedMarkdown,
    privateKeyBytes,
  });

  onProgress?.(`Broadcasting to ${relayList.length} relay${relayList.length === 1 ? '' : 's'}…`);
  const results = await Promise.allSettled(
    relayList.map((relay) => publishToRelay(relay, signedEvent))
  );

  const successes = results.filter((r) => r.status === 'fulfilled');
  if (successes.length === 0) {
    const errors = results
      .filter((r) => r.status === 'rejected')
      .map((r) => r.reason?.message || String(r.reason));
    throw new Error(errors.join(' · ') || 'Failed to publish to all relays');
  }

  return {
    eventId: signedEvent.id,
    pubkey: signedEvent.pubkey,
    relays: successes.length,
    totalRelays: relayList.length,
  };
}
