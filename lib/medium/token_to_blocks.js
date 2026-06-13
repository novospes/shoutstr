/**
 * Markdown token stream → Medium content blocks.
 *
 * Uses markdown-it tokens directly — no HTML roundtrip, no DOM parsing.
 * This avoids marked/linkedom list-collapse bugs that broke bullet lists.
 */

import {
  M_BOLD,
  M_CODE,
  M_ITALIC,
  M_LINK,
  M_STRIKE,
  P_BLOCKQUOTE,
  P_H1,
  P_H2,
  P_H3,
  P_HR,
  P_OLI,
  P_PARA,
  P_PRE,
  P_ULI,
} from './constants.js';
import { getMarkdownParser } from './parser.js';
import { preprocessMarkdown, stripLeadingH1 } from './preprocess.js';

function attrValue(attrs, name) {
  if (!Array.isArray(attrs)) return '';
  const entry = attrs.find(([key]) => key === name);
  return entry?.[1] ?? '';
}

function pushTextBlock(results, paraType, text, markups, extra = {}) {
  const trimmed = text.trim();
  if (!trimmed) return;
  results.push({ kind: 'text', type: paraType, text: trimmed, markups, ...extra });
}

function pushImageBlock(results, src, alt) {
  if (!src) return;
  results.push({ kind: 'image', src, alt: alt || '' });
}

function collectInline(children = []) {
  const result = { text: '', markups: [] };
  let i = 0;

  const walkUntil = (closeType) => {
    while (i < children.length && children[i].type !== closeType) {
      consumeToken();
    }
    if (i < children.length && children[i].type === closeType) {
      i += 1;
    }
  };

  const consumeToken = () => {
    const token = children[i];
    const type = token.type;

    if (type === 'text') {
      result.text += token.content || '';
      i += 1;
      return;
    }

    if (type === 'softbreak' || type === 'hardbreak') {
      result.text += '\n';
      i += 1;
      return;
    }

    if (type === 'code_inline') {
      const start = result.text.length;
      result.text += token.content || '';
      const end = result.text.length;
      if (end > start) result.markups.push({ type: M_CODE, start, end });
      i += 1;
      return;
    }

    if (type === 'image') {
      i += 1;
      return;
    }

    if (type === 'strong_open') {
      const start = result.text.length;
      i += 1;
      walkUntil('strong_close');
      const end = result.text.length;
      if (end > start) result.markups.push({ type: M_BOLD, start, end });
      return;
    }

    if (type === 'em_open') {
      const start = result.text.length;
      i += 1;
      walkUntil('em_close');
      const end = result.text.length;
      if (end > start) result.markups.push({ type: M_ITALIC, start, end });
      return;
    }

    if (type === 's_open') {
      const start = result.text.length;
      i += 1;
      walkUntil('s_close');
      const end = result.text.length;
      if (end > start) result.markups.push({ type: M_STRIKE, start, end });
      return;
    }

    if (type === 'link_open') {
      const start = result.text.length;
      const href = attrValue(token.attrs, 'href');
      i += 1;
      walkUntil('link_close');
      const end = result.text.length;
      if (end > start) {
        result.markups.push({
          type: M_LINK,
          start,
          end,
          href,
          anchorType: 0,
        });
      }
      return;
    }

    i += 1;
  };

  while (i < children.length) {
    consumeToken();
  }

  return result;
}

function singleImageFromInline(inlineToken) {
  const children = inlineToken?.children || [];
  if (children.length !== 1 || children[0].type !== 'image') return null;

  const image = children[0];
  return {
    src: attrValue(image.attrs, 'src'),
    alt: attrValue(image.attrs, 'alt') || image.content || '',
  };
}

function headingTypeFromTag(tag) {
  if (tag === 'h1') return P_H1;
  if (tag === 'h2') return P_H2;
  return P_H3;
}

function processListItems(tokens, startIndex, endType, itemType, results) {
  let i = startIndex;

  while (i < tokens.length && tokens[i].type !== endType) {
    const token = tokens[i];

    if (token.type === 'list_item_open') {
      i += 1;
      let pendingText = '';
      let pendingMarkups = [];

      while (i < tokens.length && tokens[i].type !== 'list_item_close') {
        const inner = tokens[i];

        if (inner.type === 'bullet_list_open' || inner.type === 'ordered_list_open') {
          pushTextBlock(results, itemType, pendingText, pendingMarkups);
          pendingText = '';
          pendingMarkups = [];

          const nestedEnd = inner.type === 'bullet_list_open' ? 'bullet_list_close' : 'ordered_list_close';
          const nestedItemType = inner.type === 'bullet_list_open' ? P_ULI : P_OLI;
          i = processListItems(tokens, i + 1, nestedEnd, nestedItemType, results) + 1;
          continue;
        }

        if (inner.type === 'paragraph_open') {
          const inline = tokens[i + 1];
          const image = singleImageFromInline(inline);
          if (image?.src) {
            pushImageBlock(results, image.src, image.alt);
            i += 3;
            continue;
          }

          const collected = collectInline(inline?.children || []);
          pendingText = collected.text;
          pendingMarkups = collected.markups;
          i += 3;
          continue;
        }

        if (inner.type === 'inline') {
          const collected = collectInline(inner.children || []);
          pendingText = collected.text;
          pendingMarkups = collected.markups;
          i += 1;
          continue;
        }

        i += 1;
      }

      pushTextBlock(results, itemType, pendingText, pendingMarkups);
    }

    i += 1;
  }

  return i;
}

function processBlockTokens(tokens, startIndex, endIndex, results) {
  let i = startIndex;

  while (i < endIndex) {
    const token = tokens[i];

    if (token.type === 'heading_open') {
      const inline = tokens[i + 1];
      const collected = collectInline(inline?.children || []);
      pushTextBlock(results, headingTypeFromTag(token.tag), collected.text, collected.markups);
      i += 3;
      continue;
    }

    if (token.type === 'paragraph_open') {
      const inline = tokens[i + 1];
      const image = singleImageFromInline(inline);
      if (image?.src) {
        pushImageBlock(results, image.src, image.alt);
        i += 3;
        continue;
      }

      const collected = collectInline(inline?.children || []);
      pushTextBlock(results, P_PARA, collected.text, collected.markups);
      i += 3;
      continue;
    }

    if (token.type === 'bullet_list_open') {
      i = processListItems(tokens, i + 1, 'bullet_list_close', P_ULI, results) + 1;
      continue;
    }

    if (token.type === 'ordered_list_open') {
      i = processListItems(tokens, i + 1, 'ordered_list_close', P_OLI, results) + 1;
      continue;
    }

    if (token.type === 'blockquote_open') {
      let quoteText = '';
      let quoteMarkups = [];
      i += 1;
      while (i < endIndex && tokens[i].type !== 'blockquote_close') {
        if (tokens[i].type === 'paragraph_open') {
          const collected = collectInline(tokens[i + 1]?.children || []);
          quoteText = collected.text;
          quoteMarkups = collected.markups;
          i += 3;
          continue;
        }
        i += 1;
      }
      pushTextBlock(results, P_BLOCKQUOTE, quoteText, quoteMarkups);
      i += 1;
      continue;
    }

    if (token.type === 'fence') {
      const langMatch = (token.info || '').trim().match(/^[\w-]+/);
      const lang = langMatch?.[0] || '';
      const codeBlockMetadata = lang ? { lang, mode: 'AUTO' } : undefined;
      pushTextBlock(results, P_PRE, token.content || '', [], { codeBlockMetadata });
      i += 1;
      continue;
    }

    if (token.type === 'code_block') {
      pushTextBlock(results, P_PRE, token.content || '', []);
      i += 1;
      continue;
    }

    if (token.type === 'hr') {
      pushTextBlock(results, P_HR, '', []);
      i += 1;
      continue;
    }

    i += 1;
  }
}

export function tokensToBlocks(tokens) {
  const results = [];
  processBlockTokens(tokens, 0, tokens.length, results);
  return results;
}

export function markdownToBlocks(markdownContent, { stripH1 = true } = {}) {
  let markdown = markdownContent || '';
  if (stripH1) markdown = stripLeadingH1(markdown);
  markdown = preprocessMarkdown(markdown);

  const tokens = getMarkdownParser().parse(markdown);
  return tokensToBlocks(tokens);
}
