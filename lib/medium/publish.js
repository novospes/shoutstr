import { processPublishImages } from '../image_handler.js';
import { markdownToMediumDeltas } from './assemble_post.js';
import { mediumSessionPublish } from './fetch.js';

export async function publishToMedium({
  title,
  markdownContent,
  headerImage,
  onProgress,
}) {
  const { markdown: processedMarkdown, headerImage: processedHeader } = await processPublishImages(
    markdownContent,
    headerImage,
    'medium',
    {}
  );

  let markdown = processedMarkdown;
  if (processedHeader) {
    markdown = `![](${processedHeader})\n\n${markdown}`;
  }

  onProgress?.('Publishing to Medium…');
  const deltas = markdownToMediumDeltas(markdown, {
    title,
    stripH1: true,
    featuredImageUrl: processedHeader || '',
  });

  const data = await mediumSessionPublish({ deltas, onProgress });
  return {
    url: data.url,
    draftOnly: Boolean(data.draftOnly),
    message: data.message || '',
  };
}
