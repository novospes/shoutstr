/**
 * Assemble Shoutstr publish options (title, featured image) into Medium
 * content deltas ready for buildMediumSavePayload().
 */

import { P_H2, P_IMG, P_PARA } from './constants.js';
import { markdownToBlocks } from './md_to_deltas.js';

function makeTextDelta(index, paraType, text, markups, extra = {}) {
  return {
    type: 1,
    index,
    paragraph: {
      type: paraType,
      text,
      markups,
      alignment: 1,
      ...extra,
    },
  };
}

function makeImageDelta(index, src, alt, layout = 1) {
  const metadata = {
    _sourceUrl: src,
    originalWidth: 1200,
    originalHeight: 630,
    alt: alt || null,
  };
  if (layout === 10) metadata.isFeatured = true;

  return {
    type: 1,
    index,
    paragraph: {
      type: P_IMG,
      text: alt || '',
      markups: [],
      alignment: 1,
      layout,
      metadata,
    },
  };
}

export function markdownToMediumDeltas(
  markdownContent,
  { title = '', stripH1 = true, featuredImageUrl = '' } = {},
) {
  const blocks = markdownToBlocks(markdownContent, { stripH1 });
  const deltas = [];
  let index = 0;
  const normalizedFeatured = featuredImageUrl ? featuredImageUrl.trim() : '';
  let featuredUsed = false;

  if (title) {
    deltas.push(makeTextDelta(index, P_H2, title, []));
    index += 1;
  }

  for (const block of blocks) {
    if (block.kind === 'text' && block.text && title) {
      const normalizedTitle = title.trim().toLowerCase();
      const normalizedText = block.text.trim().toLowerCase();
      if (normalizedText === normalizedTitle) continue;
    }

    if (block.kind === 'image') {
      const useFeaturedLayout = !featuredUsed
        && normalizedFeatured
        && block.src === normalizedFeatured;
      if (useFeaturedLayout) featuredUsed = true;
      deltas.push(makeImageDelta(
        index,
        block.src,
        block.alt,
        useFeaturedLayout ? 10 : 1,
      ));
      index += 1;
      continue;
    }

    const { type, text, markups, codeBlockMetadata } = block;
    const extra = codeBlockMetadata ? { codeBlockMetadata } : {};
    deltas.push(makeTextDelta(index, type, text, markups, extra));
    index += 1;
  }

  if (deltas.length === 0) {
    deltas.push(makeTextDelta(0, P_PARA, '', []));
  }

  return deltas;
}
