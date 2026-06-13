import {
  normalizeImageUrl,
  isFrontMatterImageKey,
  isFrontMatterImageEntry,
  FRONT_MATTER_IMAGE_KEYS,
} from './markdown.js';

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const MINOR_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 'to',
  'from', 'by', 'in', 'of', 'as', 'vs', 'via', 'with', 'into', 'over',
]);

function parseFrontMatterField(line) {
  const parsed = parseFrontMatterLine(line);
  if (!parsed) return null;
  return { key: parsed.key, value: parsed.value };
}

function parseFrontMatterLine(line) {
  const match = String(line).trim().match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
  if (!match) return null;

  const rawKey = match[1];
  let value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  return { key: rawKey.toLowerCase(), rawKey, value };
}

const SUBTITLE_KEYS = new Set(['subtitle', 'summary']);
const IMAGE_KEY_ORDER = FRONT_MATTER_IMAGE_KEYS;

function preferredSubtitleKey(existingYaml) {
  for (const line of String(existingYaml).split('\n')) {
    const parsed = parseFrontMatterLine(line);
    if (parsed?.key === 'subtitle') return 'subtitle';
    if (parsed?.key === 'summary') return 'summary';
  }
  return 'subtitle';
}

function preferredImageKey(existingYaml) {
  for (const line of String(existingYaml).split('\n')) {
    const parsed = parseFrontMatterLine(line);
    if (parsed && isFrontMatterImageKey(parsed.key)) return parsed.rawKey;
  }
  return 'image';
}

function parseFrontMatterYaml(yaml) {
  const fields = {};
  for (const line of yaml.split('\n')) {
    const parsed = parseFrontMatterField(line.trim());
    if (parsed) fields[parsed.key] = parsed.value;
  }
  return fields;
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.join(', ');
  return String(tags ?? '').trim();
}

function capitalizeWord(word) {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function titleCaseToken(token, isFirstWord) {
  if (!token) return token;

  const colonIndex = token.indexOf(':');
  if (colonIndex > 0) {
    return `${titleCaseToken(token.slice(0, colonIndex), isFirstWord)}:${token.slice(colonIndex + 1)}`;
  }

  if (token.includes('-')) {
    return token
      .split('-')
      .map((part, index) => titleCaseToken(part, isFirstWord && index === 0))
      .join('-');
  }

  const lower = token.toLowerCase();
  if (!isFirstWord && MINOR_WORDS.has(lower)) return lower;
  return capitalizeWord(token);
}

export function toTitleCase(value) {
  if (!value?.trim()) return value ?? '';

  return value
    .trim()
    .split(/\s+/)
    .map((word, index) => titleCaseToken(word, index === 0))
    .join(' ');
}

export function hasFrontMatter(text) {
  return FRONT_MATTER_RE.test(text.replace(/\r\n/g, '\n').trim());
}

export function parseDraftMarkdown(text, { filename = '', titleCase = true } = {}) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const match = normalized.match(FRONT_MATTER_RE);

  if (match) {
    const rawFrontMatter = match[1].trim();
    const frontMatter = parseFrontMatterYaml(rawFrontMatter);
    let title = frontMatter.title || '';
    let subtitle = frontMatter.subtitle || frontMatter.summary || '';

    if (titleCase) {
      title = toTitleCase(title);
      subtitle = toTitleCase(subtitle);
    }

    return {
      hadFrontMatter: true,
      rawFrontMatter,
      title,
      subtitle,
      tags: normalizeTags(frontMatter.tags),
      headerImage: headerImageFromFields(frontMatter),
      markdown: match[2].trim(),
    };
  }

  let title = '';
  let markdown = normalized;

  const h1Match = markdown.match(/^#\s+(.+)$/m);
  if (h1Match && markdown.startsWith(h1Match[0])) {
    title = titleCase ? toTitleCase(h1Match[1].trim()) : h1Match[1].trim();
    markdown = markdown.slice(h1Match[0].length).trim();
  } else if (filename) {
    const fromName = filename.replace(/\.(md|markdown|txt)$/i, '').replace(/[-_]+/g, ' ').trim();
    title = titleCase ? toTitleCase(fromName) : fromName;
  }

  return {
    hadFrontMatter: false,
    rawFrontMatter: '',
    title,
    subtitle: '',
    tags: '',
    headerImage: '',
    markdown,
  };
}

function headerImageFromFields(fields) {
  for (const key of IMAGE_KEY_ORDER) {
    if (fields[key]) return normalizeImageUrl(fields[key]);
  }

  for (const [key, value] of Object.entries(fields)) {
    if (isFrontMatterImageEntry(key, value)) {
      return normalizeImageUrl(value);
    }
  }

  return '';
}

export function parseFrontMatterFields(yamlText) {
  const fields = parseFrontMatterYaml(String(yamlText ?? '').trim());
  return {
    title: fields.title || '',
    subtitle: fields.subtitle || fields.summary || '',
    tags: normalizeTags(fields.tags),
    headerImage: headerImageFromFields(fields),
  };
}

export function stripLeadingFrontMatter(text) {
  const parsed = parseDraftMarkdown(text, { titleCase: false });
  return parsed;
}

export function yamlValue(value) {
  const str = String(value ?? '');
  if (str === '') return '""';
  if (/[:#\n\r"'&*|>|]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return str;
}

export function buildFrontMatterYaml({ title = '', subtitle = '', tags = '', headerImage = '' } = {}) {
  const lines = [
    `title: ${yamlValue(title)}`,
    `subtitle: ${yamlValue(subtitle)}`,
    `tags: ${yamlValue(normalizeTags(tags))}`,
  ];
  if (headerImage) lines.push(`image: ${yamlValue(headerImage)}`);
  return lines.join('\n');
}

export function mergeFrontMatterYaml(
  existingYaml,
  { title = '', subtitle = '', tags = '', headerImage = '' } = {},
) {
  const existing = String(existingYaml ?? '').trim();
  if (!existing) {
    return buildFrontMatterYaml({ title, subtitle, tags, headerImage });
  }

  const subtitleKey = preferredSubtitleKey(existing);
  const imageKey = preferredImageKey(existing);
  const result = [];
  const updated = new Set();

  for (const line of existing.split('\n')) {
    const parsed = parseFrontMatterLine(line);
    if (!parsed) {
      result.push(line);
      continue;
    }

    if (parsed.key === 'title') {
      result.push(`title: ${yamlValue(title)}`);
      updated.add('title');
      continue;
    }

    if (SUBTITLE_KEYS.has(parsed.key)) {
      if (parsed.rawKey === subtitleKey) {
        result.push(`${subtitleKey}: ${yamlValue(subtitle)}`);
        updated.add('subtitle');
      }
      continue;
    }

    if (parsed.key === 'tags') {
      result.push(`tags: ${yamlValue(normalizeTags(tags))}`);
      updated.add('tags');
      continue;
    }

    if (isFrontMatterImageKey(parsed.key)) {
      if (headerImage && parsed.rawKey === imageKey) {
        result.push(`${imageKey}: ${yamlValue(headerImage)}`);
        updated.add('image');
      }
      continue;
    }

    result.push(line);
  }

  if (!updated.has('title')) result.push(`title: ${yamlValue(title)}`);
  if (!updated.has('subtitle')) result.push(`${subtitleKey}: ${yamlValue(subtitle)}`);
  if (!updated.has('tags')) result.push(`tags: ${yamlValue(normalizeTags(tags))}`);
  if (headerImage && !updated.has('image')) {
    result.push(`${imageKey}: ${yamlValue(headerImage)}`);
  }

  return result.join('\n');
}

export function exportDraftMarkdown(draft) {
  const lines = ['---'];
  lines.push(mergeFrontMatterYaml(draft.frontMatterYaml, {
    title: draft.title,
    subtitle: draft.subtitle,
    tags: draft.tags,
    headerImage: draft.headerImage,
  }));
  lines.push('---', '');

  const body = draft.markdown?.trimEnd() || '';
  if (body) lines.push(body);

  return lines.join('\n');
}
