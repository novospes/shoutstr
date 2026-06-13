/** Shared markdown normalization before Medium block extraction. */

export function stripLeadingH1(markdown) {
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = lines[i].trim();
    if (stripped.startsWith('# ') && !stripped.startsWith('## ')) {
      lines.splice(i, 1);
      if (i < lines.length && !lines[i].trim()) {
        lines.splice(i, 1);
      }
      return lines.join('\n');
    }
    if (stripped) break;
  }
  return markdown;
}

export function preprocessMarkdown(markdown) {
  return markdown
    .replace(/\u00a0|\u202f|\u2007/g, ' ')
    .replace(/<YouTube\s+id="([^"]+)"\s*\/?>\s*(?:<br\s*\/?>)?/gi, '[YouTube video](https://www.youtube.com/watch?v=$1)\n\n')
    .replace(/^[ \t]+(#{1,6}\s)/gm, '$1')
    .replace(/^[ \t]+([-*+]\s+)/gm, '$1')
    .replace(/^[ \t]+(\d+[.)]\s+)/gm, '$1')
    .replace(/(#{1,6} .+)\n([-*+]\s+)/gm, '$1\n\n$2')
    .replace(/(#{1,6} .+)\n(\d+[.)]\s+)/gm, '$1\n\n$2')
    .replace(/(\S[ \t]*)\n([ \t]*[-*+]\s+)/gm, '$1\n\n$2')
    .replace(/(\S[ \t]*)\n([ \t]*\d+[.)]\s+)/gm, '$1\n\n$2');
}
