/* global marked */

export function normalizeImageUrl(raw) {
  let target = String(raw ?? '').trim();
  if (!target) return '';

  if (target.startsWith('<')) {
    const end = target.indexOf('>');
    if (end > 0) target = target.slice(1, end).trim();
  }

  const quoted = target.match(/^(\S+?)(?:\s+["'].+["'])?$/);
  if (quoted) target = quoted[1];

  return target.replace(/^["']|["']$/g, '');
}

export function extractImageUrls(markdownContent) {
  const urls = new Set();
  const markdownImagePattern = /!\[[^\]]*\]\(([^)]+)\)/g;

  let match;
  while ((match = markdownImagePattern.exec(markdownContent)) !== null) {
    const url = normalizeImageUrl(match[1]);
    if (url.startsWith('http://') || url.startsWith('https://')) {
      urls.add(url);
    }
  }

  const htmlImagePattern = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  while ((match = htmlImagePattern.exec(markdownContent)) !== null) {
    const url = normalizeImageUrl(match[1]);
    if (url.startsWith('http://') || url.startsWith('https://')) {
      urls.add(url);
    }
  }

  return [...urls];
}

export const FRONT_MATTER_IMAGE_KEYS = [
  'image',
  'header_image',
  'cover',
  'cover_image',
  'thumbnail',
  'hero',
  'hero_image',
  'banner',
  'featured_image',
  'og_image',
  'social_image',
  'photo',
  'picture',
];

const FRONT_MATTER_IMAGE_KEY_RE = /(?:^|_)(image|cover|photo|thumbnail|hero|banner|picture|avatar|og|social|featured)(?:_|$)/i;

export function isFrontMatterImageKey(key) {
  const normalized = String(key ?? '').toLowerCase();
  if (FRONT_MATTER_IMAGE_KEYS.includes(normalized)) return true;
  return FRONT_MATTER_IMAGE_KEY_RE.test(normalized);
}

export function isHttpImageUrl(raw) {
  const url = normalizeImageUrl(raw);
  return url.startsWith('http://') || url.startsWith('https://');
}

export function looksLikeImageUrl(raw) {
  const url = normalizeImageUrl(raw);
  if (!isHttpImageUrl(url)) return false;

  try {
    const { pathname } = new URL(url);
    if (/\.(png|jpe?g|webp|gif|svg|avif|bmp|ico)(\?.*)?$/i.test(pathname)) return true;
  } catch {
    /* ignore */
  }

  return /\.(png|jpe?g|webp|gif|svg|avif|bmp)(\?|#|$)/i.test(url);
}

export function isFrontMatterImageEntry(key, value) {
  if (!isHttpImageUrl(value)) return false;
  if (isFrontMatterImageKey(key)) return true;
  return looksLikeImageUrl(value);
}

export function extractFrontMatterImageUrls(frontMatterYaml) {
  const urls = new Set();
  if (!frontMatterYaml?.trim()) return [];

  for (const line of frontMatterYaml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
    if (!match) continue;

    if (!isFrontMatterImageEntry(match[1], match[2])) continue;
    urls.add(normalizeImageUrl(match[2]));
  }

  return [...urls];
}

export function collectArticleImageUrls(markdown, frontMatterYaml = '') {
  return [...new Set([
    ...extractImageUrls(markdown),
    ...extractFrontMatterImageUrls(frontMatterYaml),
  ])];
}

export function replaceImageUrl(markdownContent, oldUrl, newUrl) {
  let result = markdownContent;

  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (full, alt, target) => {
    if (normalizeImageUrl(target) !== oldUrl) return full;
    return `![${alt}](${newUrl})`;
  });

  result = result.replace(/<img\b([^>]*)\bsrc=(["'])([^"']+)\2([^>]*)>/gi, (full, before, quote, src, after) => {
    if (normalizeImageUrl(src) !== oldUrl) return full;
    return `<img${before}src=${quote}${newUrl}${quote}${after}>`;
  });

  return result;
}

export function filenameForImage(blob, imageUrl) {
  const fromType = {
    'image/png': 'image.png',
    'image/jpeg': 'image.jpg',
    'image/jpg': 'image.jpg',
    'image/webp': 'image.webp',
    'image/gif': 'image.gif',
    'image/svg+xml': 'image.svg',
  };

  if (blob.type && fromType[blob.type]) return fromType[blob.type];

  try {
    const pathname = new URL(imageUrl).pathname;
    const base = pathname.split('/').pop();
    if (base && /\.(png|jpe?g|webp|gif|svg)$/i.test(base)) return base;
  } catch {
    /* ignore */
  }

  return 'image.jpg';
}

export function markdownToHtml(markdownContent) {
  if (typeof marked === 'undefined') {
    throw new Error('marked.js is not loaded');
  }
  return marked.parse(markdownContent, { gfm: true, breaks: true });
}

/** GFM markdown for Medium — breaks:false keeps lists as <ul>/<ol>, not <p><br>. */
export function markdownToHtmlForMedium(markdownContent) {
  if (typeof marked === 'undefined') {
    throw new Error('marked.js is not loaded');
  }
  return marked.parse(markdownContent, { gfm: true, breaks: false });
}

function imageBlockFromElement(img) {
  return {
    src: img.getAttribute('src') || '',
    alt: img.getAttribute('alt') || '',
    title: img.getAttribute('title') || '',
  };
}

function isParagraphWithSingleImage(element) {
  if (element.tagName.toLowerCase() !== 'p') return null;
  const children = [...element.children];
  if (children.length !== 1 || children[0].tagName.toLowerCase() !== 'img') return null;
  if (element.textContent.trim()) return null;
  return children[0];
}

function isFigureWithSingleImage(element) {
  if (element.tagName.toLowerCase() !== 'figure') return null;
  const img = element.querySelector('img');
  if (!img) return null;
  return img;
}

export function enhanceHtmlImages(html, { medium = false } = {}) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return html;

  const replacements = [];

  root.childNodes.forEach((node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const paragraphImg = isParagraphWithSingleImage(node);
    const figureImg = paragraphImg ? null : isFigureWithSingleImage(node);
    const img = paragraphImg || figureImg;
    if (!img) return;

    if (medium) {
      const figure = doc.createElement('figure');
      figure.setAttribute('class', 'graf graf--figure graf--layoutOutsetRow');
      const clone = img.cloneNode(true);
      clone.setAttribute('class', 'graf-image');
      figure.appendChild(clone);
      replacements.push({ node, replacement: figure });
      return;
    }

    replacements.push({ node, replacement: img.cloneNode(true) });
  });

  replacements.forEach(({ node, replacement }) => {
    node.replaceWith(replacement);
  });

  return root.innerHTML;
}

function mimeTypeFromImageSrc(src) {
  try {
    const ext = new URL(src).pathname.split('.').pop()?.toLowerCase();
    const byExt = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
    };
    if (ext && byExt[ext]) return byExt[ext];
  } catch {
    /* ignore */
  }
  return 'image/jpeg';
}

export function createSubstackImageNode({
  src,
  alt = '',
  title = '',
  width = 1200,
  height = 630,
  bytes = null,
  mimeType = '',
}) {
  const content = [{
    type: 'image2',
    attrs: {
      src,
      fullscreen: null,
      imageSize: 'normal',
      height,
      width,
      resizeWidth: width,
      bytes,
      alt: alt || null,
      title: title || null,
      type: mimeType || mimeTypeFromImageSrc(src),
      href: null,
      belowTheFold: false,
      internalRedirect: null,
      topImage: false,
      isProcessing: false,
    },
  }];

  if (alt) {
    content.push({
      type: 'caption',
      content: [{ type: 'text', text: alt }],
    });
  }

  return {
    type: 'captionedImage',
    content,
  };
}

export { imageBlockFromElement, isParagraphWithSingleImage, isFigureWithSingleImage };
