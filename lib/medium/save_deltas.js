import {
  P_HR,
  P_IMG,
  P_PRE,
} from './constants.js';

export function randomHexName(length = 4) {
  const chars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * 16)];
  }
  return out;
}

function paragraphFromDelta(delta) {
  return delta?.paragraph || null;
}

function shouldUpdateParagraph(paragraph) {
  if (!paragraph) return false;
  if (paragraph.type === P_IMG) {
    return Boolean(
      paragraph.metadata?.id
      || paragraph.metadata?._sourceUrl
      || paragraph.href,
    );
  }
  if (paragraph.type === P_HR) return true;
  if (paragraph.type === P_PRE) return Boolean(paragraph.text?.trim());
  return Boolean(paragraph.text?.trim());
}

function buildInsertParagraph(source) {
  const insert = {
    name: source.name,
    type: source.type,
    text: '',
    markups: [],
  };

  if (source.type === P_IMG) {
    insert.layout = source.layout ?? 1;
    insert.metadata = {};
  }

  return insert;
}

function buildUpdateParagraph(source) {
  const update = {
    name: source.name,
    type: source.type,
    text: source.text ?? '',
    markups: source.markups ?? [],
  };

  if (source.alignment !== undefined) {
    update.alignment = source.alignment;
  }

  if (source.type === P_IMG) {
    update.layout = source.layout ?? 1;
    const { _sourceUrl, ...metadata } = source.metadata ?? {};
    update.metadata = metadata;
    if (source.href) update.href = source.href;
    if (source.iframe) update.iframe = source.iframe;
  }

  if (source.codeBlockMetadata) {
    update.codeBlockMetadata = source.codeBlockMetadata;
  }

  return update;
}

/**
 * Convert markdownToMediumDeltas output into Medium's OT save payload.
 * Medium expects a section marker plus insert (type 1) + update (type 3)
 * pairs per paragraph — a single insert with full text downgrades lists.
 */
export function buildMediumSavePayload(postId, contentDeltas) {
  if (!postId) throw new Error('Medium save payload missing post ID');
  if (!Array.isArray(contentDeltas) || contentDeltas.length === 0) {
    throw new Error('Medium draft has no content to save');
  }

  const otDeltas = [{
    type: 8,
    index: 0,
    section: {
      name: randomHexName(),
      startIndex: 0,
    },
  }];

  contentDeltas.forEach((delta, index) => {
    const source = paragraphFromDelta(delta);
    if (!source) return;

    const named = {
      ...source,
      name: source.name || randomHexName(),
    };

    otDeltas.push({
      type: 1,
      index,
      paragraph: buildInsertParagraph(named),
      ...(index > 0 ? { isStartOfSection: false } : {}),
    });

    if (shouldUpdateParagraph(named)) {
      otDeltas.push({
        type: 3,
        index,
        paragraph: buildUpdateParagraph(named),
        verifySameName: true,
      });
    }
  });

  return {
    id: postId,
    deltas: otDeltas,
    baseRev: -1,
  };
}
