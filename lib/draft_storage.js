import {
  parseDraftMarkdown,
  exportDraftMarkdown,
} from './front_matter.js';

const DRAFT_KEY = 'shoutstr:draft';
const BACKUPS_KEY = 'shoutstr:backups';
const LEGACY_DRAFT_KEY = 'crosspost:draft';
const LEGACY_BACKUPS_KEY = 'crosspost:backups';

function migrateLegacyStorageKeys() {
  if (!localStorage.getItem(DRAFT_KEY) && localStorage.getItem(LEGACY_DRAFT_KEY)) {
    localStorage.setItem(DRAFT_KEY, localStorage.getItem(LEGACY_DRAFT_KEY));
  }
  if (!localStorage.getItem(BACKUPS_KEY) && localStorage.getItem(LEGACY_BACKUPS_KEY)) {
    localStorage.setItem(BACKUPS_KEY, localStorage.getItem(LEGACY_BACKUPS_KEY));
  }
}

const MAX_BACKUPS = 10;

export function loadDraft() {
  migrateLegacyStorageKeys();
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveDraft(draft) {
  const payload = {
    title: draft.title ?? '',
    subtitle: draft.subtitle ?? '',
    tags: draft.tags ?? '',
    markdown: draft.markdown ?? '',
    platforms: draft.platforms ?? [],
    frontMatterYaml: draft.frontMatterYaml ?? '',
    headerImage: draft.headerImage ?? '',
    updatedAt: Date.now(),
  };
  localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
  return payload;
}

export function listBackups() {
  try {
    const raw = localStorage.getItem(BACKUPS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function addBackup(draft) {
  const backups = listBackups();
  const entry = {
    ...draft,
    savedAt: Date.now(),
  };

  const last = backups[0];
  if (last && last.markdown === entry.markdown && last.title === entry.title) {
    return backups;
  }

  backups.unshift(entry);
  if (backups.length > MAX_BACKUPS) backups.length = MAX_BACKUPS;
  localStorage.setItem(BACKUPS_KEY, JSON.stringify(backups));
  return backups;
}

export function restoreBackup(index) {
  const backups = listBackups();
  const backup = backups[index];
  if (!backup) return null;
  return saveDraft(backup);
}

export function removeBackup(index) {
  const backups = listBackups();
  if (index < 0 || index >= backups.length) return backups;
  backups.splice(index, 1);
  localStorage.setItem(BACKUPS_KEY, JSON.stringify(backups));
  return backups;
}

export { parseDraftMarkdown, exportDraftMarkdown };

export function importDraftMarkdown(text, options = {}) {
  const parsed = parseDraftMarkdown(text, options);
  return saveDraft({
    ...parsed,
    frontMatterYaml: parsed.rawFrontMatter,
    headerImage: parsed.headerImage || '',
    platforms: options.platforms ?? [],
  });
}

export async function migrateDraftFromChromeStorage() {
  if (loadDraft()) return null;

  const settings = await chrome.storage.local.get([
    'draftTitle',
    'draftSubtitle',
    'draftTags',
    'draftMarkdown',
  ]);

  if (!settings.draftMarkdown && !settings.draftTitle) return null;

  return saveDraft({
    title: settings.draftTitle || '',
    subtitle: settings.draftSubtitle || '',
    tags: settings.draftTags || '',
    markdown: settings.draftMarkdown || '',
    platforms: [],
  });
}

export function formatSavedTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
