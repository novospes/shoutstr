/* global markdownit */

let parserInstance = null;

export function getMarkdownParser() {
  if (parserInstance) return parserInstance;

  const MarkdownIt = globalThis.markdownit;
  if (typeof MarkdownIt !== 'function') {
    throw new Error('markdown-it is not loaded (add vendor/markdown-it.min.js before editor.js)');
  }

  parserInstance = MarkdownIt({
    html: true,
    linkify: true,
    breaks: false,
  });

  return parserInstance;
}
