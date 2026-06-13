import { publishToMedium } from '../lib/medium/publish.js';
import { publishToSubstack } from '../lib/substack/publish.js';
import { publishToNostr } from '../lib/nostr/publish.js';
import { ensurePublishImagePermissions } from '../lib/image_handler.js';
import {
  markdownToHtml,
  collectArticleImageUrls,
  normalizeImageUrl,
} from '../lib/markdown.js';
import {
  hasFrontMatter,
  parseDraftMarkdown,
  parseFrontMatterFields,
  mergeFrontMatterYaml,
  toTitleCase,
} from '../lib/front_matter.js';
import {
  loadDraft,
  saveDraft,
  addBackup,
  listBackups,
  restoreBackup,
  removeBackup,
  exportDraftMarkdown,
  importDraftMarkdown,
  migrateDraftFromChromeStorage,
  formatSavedTime,
} from '../lib/draft_storage.js';

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

const DEFAULT_PLATFORMS = [];

const AUTOSAVE_MS = 400;
const BACKUP_INTERVAL_MS = 5 * 60 * 1000;

const saveIndicator = document.getElementById('save-indicator');
const statusDrawer = document.getElementById('status-drawer');
const statusDrawerTitle = document.getElementById('status-drawer-title');
const statusList = document.getElementById('status-list');
const settingsDialog = document.getElementById('settings-dialog');
const backupsList = document.getElementById('backups-list');
const settingsTabs = document.querySelectorAll('.settings-tab');
const settingsPanels = document.querySelectorAll('.settings-panel');
const editorMain = document.getElementById('editor-main');
const previewPanel = document.getElementById('preview-panel');
const previewToggle = document.getElementById('preview-toggle');
const frontMatterPanel = document.getElementById('front-matter-panel');
const frontMatterContent = document.getElementById('front-matter-content');

const titleInput = document.getElementById('title');
const subtitleInput = document.getElementById('subtitle');
const tagsInput = document.getElementById('tags');
const editor = document.getElementById('editor');

const platformMedium = document.getElementById('platform-medium');
const platformSubstack = document.getElementById('platform-substack');
const platformNostr = document.getElementById('platform-nostr');

const substackUrlInput = document.getElementById('substack-url');
const nostrNsecInput = document.getElementById('nostr-nsec');
const nostrRelaysInput = document.getElementById('nostr-relays');

const importDropzone = document.getElementById('import-dropzone');
const importBackupInput = document.getElementById('import-backup');
const publishBtn = document.getElementById('publish-btn');

const headerImageField = document.getElementById('header-image-field');
const headerImageChoose = document.getElementById('header-image-choose');
const headerImageSelected = document.getElementById('header-image-selected');
const headerImageOpen = document.getElementById('header-image-open');
const headerImageClear = document.getElementById('header-image-clear');
const headerImageThumb = document.getElementById('header-image-thumb');
const headerImageDialog = document.getElementById('header-image-dialog');
const headerImageGallery = document.getElementById('header-image-gallery');
const headerImageEmpty = document.getElementById('header-image-empty');

let headerImage = '';

let cachedSettings = {};
let autosaveTimer = null;
let backupTimer = null;
let lastBackupAt = 0;
let lastPublishPayload = null;
let previewOpen = false;
let syncingFrontMatter = false;

function getDraftFromForm() {
  return {
    title: titleInput.value,
    subtitle: subtitleInput.value,
    tags: tagsInput.value,
    markdown: editor.value,
    platforms: getSelectedPlatforms(),
    frontMatterYaml: frontMatterContent.value,
    headerImage,
  };
}

function setHeaderImage(url) {
  headerImage = url || '';
  updateHeaderImageUi();
  syncFrontMatterFromFields();
  scheduleAutosave();
  if (previewOpen) updatePreview();
}

function updateHeaderImageUi() {
  const availableImages = collectGalleryImages();
  const hasImages = availableImages.length > 0;

  if (!hasImages && !headerImage) {
    headerImageField.classList.add('hidden');
    return;
  }

  headerImageField.classList.remove('hidden');

  if (headerImage) {
    headerImageThumb.src = headerImage;
    headerImageOpen.title = headerImage;
    headerImageChoose.classList.add('hidden');
    headerImageSelected.classList.remove('hidden');
    return;
  }

  headerImageThumb.removeAttribute('src');
  headerImageSelected.classList.add('hidden');
  headerImageChoose.classList.toggle('hidden', !hasImages);
}

function collectGalleryImages() {
  const urls = new Set(collectArticleImageUrls(editor.value, frontMatterContent.value));
  if (headerImage) urls.add(normalizeImageUrl(headerImage));
  return [...urls];
}

function galleryIncludesImage(url) {
  const target = normalizeImageUrl(url);
  return collectGalleryImages().some((candidate) => normalizeImageUrl(candidate) === target);
}

function renderHeaderImageGallery() {
  const urls = collectGalleryImages();
  headerImageGallery.innerHTML = '';

  if (urls.length === 0) {
    headerImageEmpty.classList.remove('hidden');
    return;
  }

  headerImageEmpty.classList.add('hidden');

  urls.forEach((url) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `gallery-item${normalizeImageUrl(url) === normalizeImageUrl(headerImage) ? ' selected' : ''}`;

    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';

    const label = document.createElement('span');
    label.className = 'gallery-item-url';
    label.textContent = url;

    item.append(img, label);
    item.addEventListener('click', () => {
      setHeaderImage(url);
      headerImageDialog.close();
    });
    headerImageGallery.appendChild(item);
  });
}

function openHeaderImageGallery() {
  renderHeaderImageGallery();
  headerImageDialog.showModal();
}

function syncFrontMatterFromFields() {
  if (syncingFrontMatter) return;
  syncingFrontMatter = true;
  frontMatterContent.value = mergeFrontMatterYaml(frontMatterContent.value, {
    title: titleInput.value,
    subtitle: subtitleInput.value,
    tags: tagsInput.value,
    headerImage,
  });
  syncingFrontMatter = false;
}

function syncFieldsFromFrontMatter() {
  if (syncingFrontMatter) return;
  syncingFrontMatter = true;

  const fields = parseFrontMatterFields(frontMatterContent.value);
  if (fields.title !== undefined) titleInput.value = toTitleCase(fields.title);
  if (fields.subtitle !== undefined) subtitleInput.value = toTitleCase(fields.subtitle);
  if (fields.tags !== undefined) tagsInput.value = fields.tags;
  if (fields.headerImage !== undefined) {
    headerImage = fields.headerImage;
    updateHeaderImageUi();
  }

  syncingFrontMatter = false;
  if (previewOpen) updatePreview();
}

function prefillMetadata(parsed, { overwrite = false } = {}) {
  if (parsed.title && (overwrite || !titleInput.value.trim())) {
    titleInput.value = parsed.title;
  }
  if (parsed.subtitle && (overwrite || !subtitleInput.value.trim())) {
    subtitleInput.value = parsed.subtitle;
  }
  if (parsed.tags && (overwrite || !tagsInput.value.trim())) {
    tagsInput.value = parsed.tags;
  }
  if (parsed.headerImage && (overwrite || !headerImage)) {
    headerImage = parsed.headerImage;
    updateHeaderImageUi();
  }
}

function applyParsedFrontMatter(parsed, { overwrite = false } = {}) {
  prefillMetadata(parsed, { overwrite });
  if (parsed.hadFrontMatter && parsed.rawFrontMatter) {
    syncingFrontMatter = true;
    frontMatterContent.value = parsed.rawFrontMatter;
    syncingFrontMatter = false;
  }
  syncFrontMatterFromFields();
  return parsed.markdown;
}

function normalizeMarkdownContent(markdown) {
  if (!hasFrontMatter(markdown)) return { markdown, parsed: null };
  const parsed = parseDraftMarkdown(markdown);
  return { markdown: parsed.markdown, parsed };
}

function insertTextAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = before + text + after;
  const pos = start + text.length;
  textarea.selectionStart = pos;
  textarea.selectionEnd = pos;
}

function applyDraftToForm(draft) {
  let title = draft.title || '';
  let subtitle = draft.subtitle || '';
  let tags = draft.tags || '';
  let markdown = draft.markdown || '';
  let frontMatterYaml = draft.frontMatterYaml || '';
  headerImage = draft.headerImage || '';

  const embedded = normalizeMarkdownContent(markdown);
  if (embedded.parsed) {
    title = embedded.parsed.title || title;
    subtitle = embedded.parsed.subtitle || subtitle;
    tags = embedded.parsed.tags || tags;
    markdown = embedded.parsed.markdown;
    frontMatterYaml = embedded.parsed.rawFrontMatter;
    if (embedded.parsed.headerImage) headerImage = embedded.parsed.headerImage;
  }

  titleInput.value = title;
  subtitleInput.value = subtitle;
  tagsInput.value = tags;
  editor.value = markdown;
  setPlatformCheckboxes(draft.platforms ?? DEFAULT_PLATFORMS);

  if (frontMatterYaml) {
    syncingFrontMatter = true;
    frontMatterContent.value = frontMatterYaml;
    syncingFrontMatter = false;
    syncFieldsFromFrontMatter();
  } else {
    syncFrontMatterFromFields();
  }

  updateHeaderImageUi();
}

function setSaveIndicator(state, timestamp) {
  saveIndicator.classList.remove('saved', 'unsaved');
  if (state === 'saved') {
    saveIndicator.classList.add('saved');
    saveIndicator.textContent = timestamp
      ? `Saved ${formatSavedTime(timestamp)}`
      : 'Saved';
  } else if (state === 'unsaved') {
    saveIndicator.classList.add('unsaved');
    saveIndicator.textContent = 'Unsaved changes…';
  } else {
    saveIndicator.textContent = state;
  }
}

function persistDraft({ createBackup = false } = {}) {
  const draft = saveDraft(getDraftFromForm());
  setSaveIndicator('saved', draft.updatedAt);

  if (createBackup) {
    addBackup(draft);
    lastBackupAt = Date.now();
  }

  return draft;
}

function scheduleAutosave({ refreshPreview = true } = {}) {
  setSaveIndicator('unsaved');
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    persistDraft();
    maybeCreatePeriodicBackup();
    if (refreshPreview && previewOpen) updatePreview();
  }, AUTOSAVE_MS);
}

function updatePreview() {
  const title = titleInput.value.trim();
  const subtitle = subtitleInput.value.trim();
  const markdown = editor.value.trim();

  if (!title && !subtitle && !markdown) {
    previewPanel.innerHTML = '<p class="preview-empty">Nothing to preview yet.</p>';
    return;
  }

  const parts = [];

  if (headerImage) {
    parts.push(`<img class="preview-header-image" src="${escapeAttr(headerImage)}" alt="" />`);
  }

  if (title || subtitle) {
    parts.push('<header class="preview-header">');
    if (title) parts.push(`<h1 class="preview-title">${escapeHtml(title)}</h1>`);
    if (subtitle) parts.push(`<p class="preview-subtitle">${escapeHtml(subtitle)}</p>`);
    parts.push('</header>');
  }

  if (markdown) {
    parts.push(`<div class="preview-body">${markdownToHtml(markdown)}</div>`);
  }

  previewPanel.innerHTML = parts.join('');
}

function setPreviewOpen(open) {
  previewOpen = open;
  previewToggle.classList.toggle('active', open);
  editorMain.classList.toggle('preview-open', open);
  previewPanel.classList.toggle('hidden', !open);

  if (open) {
    updatePreview();
  }
}

function maybeCreatePeriodicBackup() {
  const now = Date.now();
  if (now - lastBackupAt >= BACKUP_INTERVAL_MS) {
    persistDraft({ createBackup: true });
  }
}

function getSelectedPlatforms() {
  const platforms = [];
  if (platformMedium.checked) platforms.push('medium');
  if (platformSubstack.checked) platforms.push('substack');
  if (platformNostr.checked) platforms.push('nostr');
  return platforms;
}

function setPlatformCheckboxes(platforms) {
  platformMedium.checked = platforms.includes('medium');
  platformSubstack.checked = platforms.includes('substack');
  platformNostr.checked = platforms.includes('nostr');
}

function parseRelays(text) {
  return text
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function loadSettings() {
  const settings = await chrome.storage.local.get([
    'nostrNsec',
    'nostrRelays',
    'substackUrl',
  ]);

  cachedSettings = settings;

  substackUrlInput.value = settings.substackUrl || '';
  nostrNsecInput.value = settings.nostrNsec || '';
  nostrRelaysInput.value = (settings.nostrRelays || DEFAULT_RELAYS).join('\n');
}

async function saveSettings() {
  const settings = {
    substackUrl: substackUrlInput.value.trim(),
    nostrNsec: nostrNsecInput.value.trim(),
    nostrRelays: parseRelays(nostrRelaysInput.value),
  };

  await chrome.storage.local.set(settings);
  cachedSettings = { ...cachedSettings, ...settings };
}

async function loadDraftIntoEditor() {
  await migrateDraftFromChromeStorage();

  const draft = loadDraft();
  if (draft) {
    applyDraftToForm(draft);
    setSaveIndicator('saved', draft.updatedAt);
    lastBackupAt = Date.now();
    return;
  }

  const defaults = DEFAULT_PLATFORMS;
  setPlatformCheckboxes(defaults);
  syncFrontMatterFromFields();
  setSaveIndicator('saved');
}

function setSettingsTab(tabName) {
  settingsTabs.forEach((tab) => {
    const active = tab.dataset.tab === tabName;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  settingsPanels.forEach((panel) => {
    const active = panel.id === `settings-panel-${tabName}`;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
}

function draftFilename(draft) {
  const slug = (draft.title || 'shoutstr-draft').replace(/[^\w-]+/g, '-').slice(0, 40);
  return `${slug || 'shoutstr-draft'}.md`;
}

function renderBackupsList() {
  const backups = listBackups();
  backupsList.innerHTML = '';

  if (backups.length === 0) {
    backupsList.innerHTML = '<p class="backup-empty">No backups yet. Snapshots are created every 5 minutes while you edit.</p>';
    return;
  }

  backups.forEach((backup, index) => {
    const item = document.createElement('div');
    item.className = 'backup-item';

    const meta = document.createElement('div');
    meta.className = 'backup-meta';
    meta.innerHTML = `
      <div class="backup-title">${escapeHtml(backup.title || 'Untitled draft')}</div>
      <div class="backup-time">${formatSavedTime(backup.savedAt || backup.updatedAt)}</div>
    `;

    const actions = document.createElement('div');
    actions.className = 'backup-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-ghost btn-sm';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
      const restored = restoreBackup(index);
      if (restored) {
        applyDraftToForm(restored);
        setSaveIndicator('saved', restored.updatedAt);
        if (previewOpen) updatePreview();
        settingsDialog.close();
      }
    });

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn btn-ghost btn-sm';
    exportBtn.textContent = 'Export';
    exportBtn.addEventListener('click', () => {
      downloadMarkdown(draftFilename(backup), exportDraftMarkdown(backup));
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-ghost btn-sm btn-danger';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      if (!confirm('Remove this saved snapshot?')) return;
      removeBackup(index);
      renderBackupsList();
    });

    actions.append(editBtn, exportBtn, removeBtn);
    item.append(meta, actions);
    backupsList.appendChild(item);
  });
}

function downloadMarkdown(filename, content) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function renderStatusItem(platform, state, detail = '', link = '', showRetry = false) {
  const item = document.createElement('div');
  item.className = 'status-item';
  item.dataset.platform = platform;

  if (state === 'pending') {
    item.innerHTML = `
      <div class="status-row">
        <span class="status-platform">${capitalize(platform)}</span>
      </div>
      <div class="status-progress">
        <span class="spinner" aria-hidden="true"></span>
        <span class="status-progress-text">${escapeHtml(detail || 'Starting…')}</span>
      </div>
    `;
    return item;
  }

  const badgeClass = state === 'success' ? 'success' : state === 'warning' ? 'warning' : 'error';
  const badgeText = state === 'success'
    ? '✓ Published'
    : state === 'warning'
      ? '⚠ Draft saved'
      : '✗ Failed';

  item.innerHTML = `
    <div class="status-row">
      <span class="status-platform">${capitalize(platform)}</span>
      <span class="status-badge ${badgeClass}">${badgeText}</span>
    </div>
    <div class="status-detail">${escapeHtml(detail)}</div>
  `;

  if (link || showRetry) {
    const actions = document.createElement('div');
    actions.className = 'status-actions';

    if (link) {
      const anchor = document.createElement('a');
      anchor.href = link;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.className = 'btn-link';
      anchor.textContent = 'Open →';
      actions.appendChild(anchor);
    }

    if (showRetry) {
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn-link';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', () => retryPlatform(platform));
      actions.appendChild(retryBtn);
    }

    item.appendChild(actions);
  }

  return item;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function showStatusDrawer(platforms) {
  statusList.innerHTML = '';
  if (statusDrawerTitle) statusDrawerTitle.textContent = 'Publishing…';
  platforms.forEach((platform) => {
    statusList.appendChild(renderStatusItem(platform, 'pending', 'Starting…'));
  });
  statusDrawer.classList.remove('hidden');
}

function updateStatusProgress(platform, message) {
  const item = statusList.querySelector(`[data-platform="${platform}"]`);
  if (!item) return;
  const textEl = item.querySelector('.status-progress-text');
  if (textEl) textEl.textContent = message;
}

function setStatusDrawerComplete() {
  if (statusDrawerTitle) statusDrawerTitle.textContent = 'Publish results';
}

function updateStatusItem(platform, state, detail = '', link = '') {
  const existing = statusList.querySelector(`[data-platform="${platform}"]`);
  const showRetry = state === 'error';
  const replacement = renderStatusItem(platform, state, detail, link, showRetry);
  if (existing) existing.replaceWith(replacement);
  else statusList.appendChild(replacement);
}

async function retryPlatform(platform) {
  if (!lastPublishPayload) return;

  updateStatusItem(platform, 'pending', 'Retrying…');

  try {
    const value = await publishToPlatform(platform, lastPublishPayload, (message) => {
      updateStatusProgress(platform, message);
    });
    const link = getResultLink(platform, value);
    const state = value?.draftOnly ? 'warning' : 'success';
    updateStatusItem(platform, state, getResultDetail(platform, value), link);
  } catch (error) {
    updateStatusItem(platform, 'error', error.message || 'Unknown error');
  }
}

async function publishToPlatform(platform, payload, onProgress) {
  switch (platform) {
    case 'medium':
      return publishToMedium({
        title: payload.title,
        markdownContent: payload.markdown,
        headerImage: payload.headerImage,
        onProgress,
      });
    case 'substack':
      return publishToSubstack({
        title: payload.title,
        subtitle: payload.subtitle,
        tags: payload.tags,
        markdownContent: payload.markdown,
        headerImage: payload.headerImage,
        publicationUrl: cachedSettings.substackUrl,
        onProgress,
      });
    case 'nostr':
      return publishToNostr({
        title: payload.title,
        subtitle: payload.subtitle,
        tags: payload.tags,
        markdownContent: payload.markdown,
        headerImage: payload.headerImage,
        nsec: cachedSettings.nostrNsec,
        relays: cachedSettings.nostrRelays || DEFAULT_RELAYS,
        onProgress,
      });
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

function getResultLink(platform, value) {
  if (platform === 'nostr') {
    return `https://primal.net/e/${value.eventId}`;
  }
  return value.url;
}

function getResultDetail(platform, value) {
  if (platform === 'nostr') {
    return `Event ${value.eventId} (${value.relays}/${value.totalRelays} relays)`;
  }
  if (platform === 'medium' && value.draftOnly) {
    return 'Draft saved on Medium. Hit Publish there, or retry here in a few minutes.';
  }
  return value.url;
}

async function handlePublish() {
  const draft = getDraftFromForm();
  const markdown = draft.markdown.trim();
  const title = draft.title.trim();
  const subtitle = draft.subtitle.trim();
  const tags = draft.tags.split(',').map((t) => t.trim()).filter(Boolean);
  const platforms = draft.platforms;

  if (!title) {
    alert('Please enter a title');
    titleInput.focus();
    return;
  }

  if (!markdown) {
    alert('Please enter markdown content');
    editor.focus();
    return;
  }

  if (platforms.length === 0) {
    alert('Select at least one platform');
    return;
  }

  if (platforms.includes('nostr') && !cachedSettings.nostrNsec?.trim()) {
    alert('Add your Nostr private key in Settings to publish to Nostr');
    settingsDialog.showModal();
    setSettingsTab('config');
    return;
  }

  try {
    await ensurePublishImagePermissions(markdown, headerImage);
  } catch {
    /* continue with publish */
  }

  persistDraft({ createBackup: true });
  publishBtn.disabled = true;
  showStatusDrawer(platforms);

  const payload = {
    title,
    subtitle,
    tags,
    markdown,
    headerImage,
  };
  lastPublishPayload = payload;

  const results = await Promise.allSettled(
    platforms.map((platform) => publishToPlatform(platform, payload, (message) => {
      updateStatusProgress(platform, message);
    }))
  );

  results.forEach((result, index) => {
    const platform = platforms[index];
    if (result.status === 'fulfilled') {
      const link = getResultLink(platform, result.value);
      const state = result.value?.draftOnly ? 'warning' : 'success';
      updateStatusItem(platform, state, getResultDetail(platform, result.value), link);
    } else {
      updateStatusItem(platform, 'error', result.reason?.message || 'Unknown error');
    }
  });

  setStatusDrawerComplete();
  publishBtn.disabled = false;
}

function bindAutosave(el) {
  el.addEventListener('input', scheduleAutosave);
}

function bindTitleCaseOnBlur(el) {
  el.addEventListener('blur', () => {
    const next = toTitleCase(el.value);
    if (next !== el.value) {
      el.value = next;
    }
    syncFrontMatterFromFields();
    scheduleAutosave();
    if (previewOpen) updatePreview();
  });
}

function bindMetadataAutosave(el) {
  el.addEventListener('input', () => {
    syncFrontMatterFromFields();
    scheduleAutosave();
  });
}

function handleFrontMatterInput() {
  syncFieldsFromFrontMatter();
  if (headerImage && !galleryIncludesImage(headerImage)) {
    setHeaderImage('');
    return;
  }
  updateHeaderImageUi();
  scheduleAutosave();
}

function handleEditorPaste(event) {
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (!hasFrontMatter(text)) return;

  event.preventDefault();

  const parsed = parseDraftMarkdown(text);
  const body = parsed.markdown;
  const replacingAll = !editor.value.trim()
    || (editor.selectionStart === 0 && editor.selectionEnd === editor.value.length);

  if (replacingAll) {
    editor.value = body;
  } else {
    insertTextAtCursor(editor, body);
  }

  applyParsedFrontMatter(parsed, { overwrite: replacingAll });
  scheduleAutosave();
  if (previewOpen) updatePreview();
}

editor.addEventListener('paste', handleEditorPaste);

document.getElementById('settings-toggle').addEventListener('click', () => {
  setSettingsTab('config');
  renderBackupsList();
  settingsDialog.showModal();
});

settingsTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    setSettingsTab(tab.dataset.tab);
    if (tab.dataset.tab === 'saved') {
      renderBackupsList();
    }
  });
});

document.getElementById('settings-close').addEventListener('click', () => {
  settingsDialog.close();
});

document.getElementById('settings-cancel').addEventListener('click', () => {
  settingsDialog.close();
});

document.getElementById('settings-save').addEventListener('click', async () => {
  await saveSettings();
  settingsDialog.close();
});

previewToggle.addEventListener('click', () => {
  setPreviewOpen(!previewOpen);
});

document.getElementById('status-close').addEventListener('click', () => {
  statusDrawer.classList.add('hidden');
});

function isMarkdownFile(file) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith('.md')
    || name.endsWith('.markdown')
    || name.endsWith('.txt')
    || file.type === 'text/markdown'
    || file.type === 'text/plain'
  );
}

async function importFile(file) {
  if (!isMarkdownFile(file)) {
    throw new Error('Unsupported file type. Use a .md or .markdown file.');
  }

  const text = await file.text();
  return importDraftMarkdown(text, { filename: file.name });
}

async function handleImportFile(file) {
  if (!file) return;

  try {
    const restored = await importFile(file);
    applyDraftToForm(restored);
    setSaveIndicator('saved', restored.updatedAt);
    if (previewOpen) updatePreview();
    renderBackupsList();
    settingsDialog.close();
  } catch (error) {
    alert(`Import failed: ${error.message}`);
  }
}

function bindImportDropzone() {
  importDropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    importDropzone.classList.add('drag-over');
  });

  importDropzone.addEventListener('dragleave', (event) => {
    if (!importDropzone.contains(event.relatedTarget)) {
      importDropzone.classList.remove('drag-over');
    }
  });

  importDropzone.addEventListener('drop', async (event) => {
    event.preventDefault();
    importDropzone.classList.remove('drag-over');
    await handleImportFile(event.dataTransfer?.files?.[0]);
  });

  importBackupInput.addEventListener('change', async (event) => {
    await handleImportFile(event.target.files?.[0]);
    event.target.value = '';
  });
}

publishBtn.addEventListener('click', handlePublish);

bindAutosave(editor);
bindMetadataAutosave(titleInput);
bindMetadataAutosave(subtitleInput);
bindMetadataAutosave(tagsInput);
bindTitleCaseOnBlur(titleInput);
bindTitleCaseOnBlur(subtitleInput);
frontMatterContent.addEventListener('input', handleFrontMatterInput);

headerImageChoose.addEventListener('click', openHeaderImageGallery);
headerImageOpen.addEventListener('click', openHeaderImageGallery);
headerImageClear.addEventListener('click', () => setHeaderImage(''));
document.getElementById('header-image-close').addEventListener('click', () => headerImageDialog.close());
document.getElementById('header-image-cancel').addEventListener('click', () => headerImageDialog.close());

editor.addEventListener('input', () => {
  if (headerImage && !galleryIncludesImage(headerImage)) {
    setHeaderImage('');
    return;
  }
  updateHeaderImageUi();
});

[platformMedium, platformSubstack, platformNostr].forEach((el) => {
  el.addEventListener('change', () => scheduleAutosave({ refreshPreview: false }));
});

window.addEventListener('beforeunload', () => {
  clearTimeout(autosaveTimer);
  persistDraft();
});

backupTimer = setInterval(maybeCreatePeriodicBackup, BACKUP_INTERVAL_MS);

async function init() {
  bindImportDropzone();
  await loadSettings();
  await loadDraftIntoEditor();
}

init().catch(() => {
  setSaveIndicator('Load failed');
});
