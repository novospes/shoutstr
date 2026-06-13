import { markdownToHtml, enhanceHtmlImages, createSubstackImageNode, isParagraphWithSingleImage, isFigureWithSingleImage } from '../markdown.js';
import { processPublishImages } from '../image_handler.js';
import { substackFetch } from './fetch.js';
import { resolveSubstackPublicationOrigin } from './publication.js';

async function resolveSubstackUserId(publicationOrigin) {
  try {
    const profile = await substackFetch('https://substack.com', '/api/v1/user/profile/self');
    if (profile?.id) return profile.id;
  } catch {
    // Some accounts 403 on profile/self; fall back to draft bylines.
  }

  const drafts = await substackFetch(publicationOrigin, '/api/v1/drafts?limit=1');
  const posts = Array.isArray(drafts) ? drafts : drafts?.drafts ?? drafts?.posts ?? [];
  const bylines = posts[0]?.publishedBylines || posts[0]?.draft_bylines || [];
  if (bylines[0]?.id) return bylines[0].id;

  throw new Error('Could not determine Substack user ID — log in at substack.com first');
}

function textNode(text, marks = []) {
  if (!text) return null;
  const node = { type: 'text', text };
  if (marks.length > 0) node.marks = marks;
  return node;
}

function paragraphFromNodes(nodes) {
  const content = nodes.filter(Boolean);
  if (content.length === 0) return { type: 'paragraph' };
  return { type: 'paragraph', content };
}

function parseInlineNodes(element) {
  const nodes = [];

  element.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const value = child.textContent;
      if (value) nodes.push(textNode(value));
      return;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) return;

    const tag = child.tagName.toLowerCase();
    if (tag === 'strong' || tag === 'b') {
      nodes.push(...parseInlineNodes(child).map((n) => {
        if (n.type !== 'text') return n;
        return { ...n, marks: [...(n.marks || []), { type: 'strong' }] };
      }));
      return;
    }

    if (tag === 'em' || tag === 'i') {
      nodes.push(...parseInlineNodes(child).map((n) => {
        if (n.type !== 'text') return n;
        return { ...n, marks: [...(n.marks || []), { type: 'em' }] };
      }));
      return;
    }

    if (tag === 'a') {
      const href = child.getAttribute('href') || '';
      nodes.push(...parseInlineNodes(child).map((n) => {
        if (n.type !== 'text') return n;
        return {
          ...n,
          marks: [
            ...(n.marks || []),
            {
              type: 'link',
              attrs: {
                href,
                target: '_blank',
                rel: 'noopener noreferrer nofollow',
                class: 'paragraph-link',
              },
            },
          ],
        };
      }));
      return;
    }

    if (tag === 'code') {
      const value = child.textContent || '';
      if (value) nodes.push(textNode(value, [{ type: 'code' }]));
      return;
    }

    nodes.push(...parseInlineNodes(child));
  });

  return nodes;
}

function blockFromElement(element) {
  const tag = element.tagName.toLowerCase();

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    return {
      type: 'heading',
      attrs: { level },
      content: parseInlineNodes(element).filter(Boolean),
    };
  }

  if (tag === 'p') {
    const img = isParagraphWithSingleImage(element);
    if (img) {
      return createSubstackImageNode({
        src: img.getAttribute('src') || '',
        alt: img.getAttribute('alt') || '',
        title: img.getAttribute('title') || '',
      });
    }
    return paragraphFromNodes(parseInlineNodes(element));
  }

  if (tag === 'figure') {
    const img = isFigureWithSingleImage(element);
    if (img) {
      return createSubstackImageNode({
        src: img.getAttribute('src') || '',
        alt: img.getAttribute('alt') || '',
        title: img.getAttribute('title') || '',
      });
    }
  }

  if (tag === 'img') {
    const src = element.getAttribute('src');
    if (!src) return null;
    return createSubstackImageNode({
      src,
      alt: element.getAttribute('alt') || '',
      title: element.getAttribute('title') || '',
    });
  }

  if (tag === 'ul' || tag === 'ol') {
    const listType = tag === 'ul' ? 'bullet_list' : 'ordered_list';
    const items = Array.from(element.children)
      .filter((li) => li.tagName.toLowerCase() === 'li')
      .map((li) => ({
        type: 'list_item',
        content: [paragraphFromNodes(parseInlineNodes(li))],
      }));

    return items.length ? { type: listType, content: items } : null;
  }

  if (tag === 'blockquote') {
    const inner = htmlToSubstackDoc(element.innerHTML).content;
    return inner.length ? { type: 'blockquote', content: inner } : null;
  }

  if (tag === 'pre') {
    const code = element.textContent || '';
    return paragraphFromNodes([textNode(code, [{ type: 'code' }])]);
  }

  if (tag === 'hr') {
    return { type: 'horizontalRule' };
  }

  return paragraphFromNodes(parseInlineNodes(element));
}

export function htmlToSubstackDoc(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  const content = [];

  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent?.trim();
      if (value) content.push(paragraphFromNodes([textNode(value)]));
      return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const block = blockFromElement(node);
      if (block) content.push(block);
    }
  });

  if (content.length === 0) {
    content.push({ type: 'paragraph' });
  }

  return { type: 'doc', content };
}

export async function publishToSubstack({
  title,
  subtitle = '',
  tags,
  markdownContent,
  headerImage,
  publicationUrl = '',
  onProgress,
}) {
  onProgress?.('Connecting to Substack…');
  const publicationOrigin = await resolveSubstackPublicationOrigin(publicationUrl);
  const { markdown: processedMarkdown, headerImage: processedHeader } = await processPublishImages(
    markdownContent,
    headerImage,
    'substack',
    { publicationOrigin, onProgress },
  );
  onProgress?.('Formatting for Substack…');
  const html = enhanceHtmlImages(markdownToHtml(processedMarkdown));
  const draftBody = htmlToSubstackDoc(html);
  const userId = await resolveSubstackUserId(publicationOrigin);

  onProgress?.('Creating draft…');
  const draftPayload = {
    draft_title: title,
    draft_subtitle: subtitle,
    draft_body: JSON.stringify(draftBody),
    draft_bylines: [{ id: userId, is_guest: false }],
    audience: 'everyone',
  };
  if (processedHeader) {
    draftPayload.cover_image = processedHeader;
  }

  const draft = await substackFetch(publicationOrigin, '/api/v1/drafts', {
    method: 'POST',
    body: JSON.stringify(draftPayload),
  });

  const draftId = draft?.id;
  if (!draftId) throw new Error('Substack draft creation failed');

  onProgress?.('Publishing…');
  const published = await substackFetch(publicationOrigin, `/api/v1/drafts/${draftId}/publish`, {
    method: 'POST',
    body: JSON.stringify({ send: false }),
  });

  const slug = published?.slug || draft?.slug;
  const url = published?.canonical_url || (slug ? `${publicationOrigin}/p/${slug}` : null);
  if (!url) throw new Error('Substack publish succeeded but no URL was returned');

  return { url, tags };
}
