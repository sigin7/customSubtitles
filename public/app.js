const $ = selector => document.querySelector(selector);
let config, rows = [], filter = 'all', pendingDelete, searchSequence = 0, toastTimer;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
function showError(selector, error) { $(selector).textContent = error.message; $(selector).hidden = false; }
function showLogin() { $('#app').hidden = true; $('#login-screen').hidden = false; $('#password').focus(); }
async function api(endpoint, options = {}) {
  const response = await fetch(endpoint, { credentials: 'same-origin', ...options });
  let body;
  try { body = await response.json(); } catch { throw new Error('Server vrátil neplatnú odpoveď.'); }
  if (!response.ok) {
    if (response.status === 401 && endpoint !== '/api/login') showLogin();
    throw new Error(body.error || 'Požiadavka zlyhala.');
  }
  return body;
}
const jsonOptions = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const formatSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const videoType = () => $('input[name="type"]:checked').value;

function renderLibrary() {
  $('#stat-total').textContent = rows.length;
  $('#nav-count').textContent = rows.length;
  $('#library-count').textContent = `${rows.length} ${rows.length === 1 ? 'titulok' : rows.length >= 2 && rows.length <= 4 ? 'titulky' : 'titulkov'}`;
  $('#stat-movies').textContent = new Set(rows.filter(row => row.type === 'movie').map(row => row.videoId)).size;
  $('#stat-episodes').textContent = new Set(rows.filter(row => row.type === 'series').map(row => row.videoId)).size;
  $('#stat-languages').textContent = new Set(rows.map(row => row.lang)).size;
  $('#storage-size').textContent = formatSize(rows.reduce((sum, row) => sum + row.bytes, 0));
  const query = $('#library-search').value.toLocaleLowerCase('sk');
  const visible = rows.filter(row => (filter === 'all' || row.type === filter) && `${row.title} ${row.originalName} ${row.imdbId} ${row.label} ${config.languages[row.lang]}`.toLocaleLowerCase('sk').includes(query));
  const list = $('#library-list'); list.replaceChildren();
  $('#library-empty').hidden = rows.length !== 0;
  if (!visible.length && rows.length) list.append(node('div', 'no-results', 'Pre tento výber sa nenašli žiadne titulky.'));
  for (const row of visible) {
    const item = node('article', 'library-row');
    const image = node('div', 'item-icon'); image.append(icon(row.type === 'movie' ? 'film' : 'tv'));
    const main = node('div', 'item-main');
    main.append(node('h3', 'item-title', row.title));
    const meta = node('div', 'item-meta');
    meta.append(node('span', '', row.type === 'series' ? `S${String(row.season).padStart(2, '0')} E${String(row.episode).padStart(2, '0')}` : 'Film'), node('span', '', row.imdbId), node('span', '', row.extension.toUpperCase()));
    main.append(meta, node('p', 'item-name', row.label || row.originalName));
    const language = node('span', 'language-pill', ({ slo: 'SK', cze: 'CZ', eng: 'EN', hun: 'HU', pol: 'PL', ger: 'DE', ukr: 'UK', spa: 'ES', fre: 'FR' })[row.lang]);
    language.title = config.languages[row.lang];
    const button = node('button', 'delete-button'); button.type = 'button'; button.setAttribute('aria-label', `Odstrániť ${row.originalName}`); button.append(icon('trash'));
    button.addEventListener('click', () => {
      pendingDelete = row.id;
      $('#delete-message').textContent = `${row.title} — ${row.originalName}. Tento súbor sa odstráni z knižnice aj z ponuky addonu.`;
      $('#delete-dialog').showModal();
    });
    item.append(image, main, language, button); list.append(item);
  }
}

async function loadLibrary() { const result = await api('/api/subtitles'); rows = result.subtitles; renderLibrary(); }
async function loadConfig() {
  config = await api('/api/config');
  $('#server-address').textContent = new URL(config.baseUrl).host;
  $('#base-url').value = config.baseUrl;
  $('#base-url').disabled = config.baseUrlLocked;
  $('#save-settings').disabled = config.baseUrlLocked;
  $('#addon-url').value = config.addonUrl;
  $('#install-addon').href = config.installUrl;
  $('#tailscale-command').textContent = `tailscale serve --bg ${config.localUrl}`;
  $('#tailscale-status').textContent = config.tailscale.running
    ? `Tailscale je pripojený.${config.tailscale.suggestedUrl ? ` Predpokladaná adresa: ${config.tailscale.suggestedUrl}` : ''} Spusť tento príkaz v termináli na serveri.`
    : 'Nainštaluj Tailscale na server aj ostatné zariadenia, prihlás ich do svojej siete a spusti tento príkaz.';
  $('#local-address-note').textContent = /^https:\/\//.test(config.baseUrl)
    ? 'Táto adresa sa použije aj na stiahnutie titulkov. Ak bol addon už nainštalovaný s inou adresou, nainštaluj ho znova.'
    : 'Lokálna HTTP adresa funguje iba na tomto počítači. Pre ďalšie zariadenia nastav HTTPS adresu Tailscale Serve.';
  $('#auth-note').textContent = config.passwordEnabled
    ? 'Správa knižnice je chránená heslom. Adresu addonu s prístupovým kľúčom zdieľaj iba so svojimi zariadeniami.'
    : 'Správa je bez hesla. Voliteľné heslo nastav cez ADMIN_PASSWORD v .env. Adresu addonu zdieľaj iba so svojimi zariadeniami.';
  $('#logout').hidden = !config.passwordEnabled;
}
async function initialize() {
  try {
    const session = await api('/api/session');
    if (!session.authenticated) { showLogin(); return; }
    await loadConfig();
    $('#login-screen').hidden = true; $('#app').hidden = false;
    await loadLibrary();
  } catch (error) { toast(error.message); }
}

function focusUpload() {
  $('#upload-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#meta-query').focus({ preventScroll: true });
}
for (const selector of ['#nav-upload', '#heading-upload', '#empty-upload']) $(selector).addEventListener('click', focusUpload);
$('#nav-library').addEventListener('click', () => $('#library-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }));
for (const selector of ['#nav-settings', '#banner-settings']) $(selector).addEventListener('click', () => { $('#settings-error').hidden = true; $('#settings-dialog').showModal(); });
$('#close-settings').addEventListener('click', () => $('#settings-dialog').close());
$('#cancel-delete').addEventListener('click', () => $('#delete-dialog').close());
$('#library-search').addEventListener('input', renderLibrary);
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => {
  filter = button.dataset.filter;
  for (const tab of document.querySelectorAll('[data-filter]')) tab.classList.toggle('selected', tab === button);
  renderLibrary();
});

function clearSelection() {
  searchSequence++;
  $('#selected-meta').hidden = true; $('#search-results').replaceChildren();
  $('#title').value = ''; $('#imdbId').value = ''; $('#manual-meta').open = true;
}
function updateType() {
  const series = videoType() === 'series';
  $('#episode-fields').hidden = !series;
  $('#season').required = series; $('#episode').required = series;
}
for (const input of document.querySelectorAll('input[name="type"]')) input.addEventListener('change', () => { clearSelection(); updateType(); });

async function searchMetadata() {
  const query = $('#meta-query').value.trim();
  if (query.length < 2) { $('#search-status').textContent = 'Zadaj aspoň dva znaky.'; return; }
  const sequence = ++searchSequence;
  $('#meta-search').disabled = true; $('#search-status').textContent = 'Hľadám v metadátach…'; $('#search-results').replaceChildren();
  try {
    const { metas } = await api(`/api/meta?type=${videoType()}&q=${encodeURIComponent(query)}`);
    if (sequence !== searchSequence) return;
    $('#search-status').textContent = metas.length ? 'Vyber správny výsledok.' : 'Nič sa nenašlo. Údaje môžeš zadať ručne.';
    for (const meta of metas) {
      const button = node('button', 'search-result'); button.type = 'button';
      if (meta.poster) { const image = node('img'); image.src = meta.poster; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; image.addEventListener('error', () => image.remove()); button.append(image); }
      const label = node('span', '', meta.name); label.append(node('small', '', `${meta.year} · ${meta.id}`)); button.append(label);
      button.addEventListener('click', () => {
        $('#title').value = meta.name; $('#imdbId').value = meta.id;
        $('#selected-meta').replaceChildren(icon('check'), node('span', '', `${meta.name}${meta.year ? ` (${meta.year})` : ''}`));
        $('#selected-meta').hidden = false; $('#manual-meta').open = false;
        $('#search-results').replaceChildren(); $('#search-status').textContent = `Spárované s ${meta.id}.`;
      });
      $('#search-results').append(button);
    }
  } catch (error) { if (sequence === searchSequence) { $('#search-status').textContent = error.message; $('#manual-meta').open = true; } }
  finally { $('#meta-search').disabled = false; }
}
$('#meta-search').addEventListener('click', searchMetadata);
$('#meta-query').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); searchMetadata(); } });

async function fileChanged() {
  const file = $('#file').files[0];
  $('#upload-error').hidden = true;
  $('#drop-zone').classList.toggle('has-file', !!file);
  if (!file) { $('#file-name').replaceChildren(document.createTextNode('Presuň súbor alebo '), node('span', '', 'vyber z počítača')); $('#file-info').textContent = 'SRT, VTT, ASS, SSA · max. 10 MB'; return; }
  $('#file-name').textContent = file.name;
  $('#file-info').textContent = `${formatSize(file.size)} · pripravený na nahratie`;
  if (file.size > 10 * 1024 * 1024) { showError('#upload-error', new Error('Súbor je väčší ako 10 MB.')); return; }
  try {
    const hints = await api(`/api/hints?filename=${encodeURIComponent(file.name)}`);
    if ($('#file').files[0] !== file) return;
    if (hints.season !== null) {
      if (videoType() !== 'series') { $('input[name="type"][value="series"]').checked = true; clearSelection(); updateType(); }
      $('#season').value = hints.season; $('#episode').value = hints.episode;
    }
    if (hints.imdbId && !$('#imdbId').value) $('#imdbId').value = hints.imdbId;
    if (hints.lang) $('#lang').value = hints.lang;
  } catch (error) { toast(error.message); }
}
$('#file').addEventListener('change', fileChanged);
$('#drop-zone').addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); $('#file').click(); } });
for (const type of ['dragenter', 'dragover']) $('#drop-zone').addEventListener(type, event => { event.preventDefault(); $('#drop-zone').classList.add('dragging'); });
for (const type of ['dragleave', 'drop']) $('#drop-zone').addEventListener(type, event => { event.preventDefault(); $('#drop-zone').classList.remove('dragging'); });
$('#drop-zone').addEventListener('drop', event => {
  if (event.dataTransfer.files.length !== 1) { showError('#upload-error', new Error('Vyber jeden súbor s titulkami.')); return; }
  $('#file').files = event.dataTransfer.files; fileChanged();
});

$('#upload-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#upload-error').hidden = true;
  if (!$('#upload-form').reportValidity()) return;
  $('#upload-submit').disabled = true;
  try {
    const result = await api('/api/subtitles', { method: 'POST', body: new FormData($('#upload-form')) });
    await loadLibrary();
    $('#file').value = ''; await fileChanged();
    toast(result.duplicate ? 'Tieto titulky už máš v knižnici.' : 'Titulky sú uložené a dostupné v addone.');
  } catch (error) { showError('#upload-error', error); }
  finally { $('#upload-submit').disabled = false; }
});

$('#confirm-delete').addEventListener('click', async () => {
  $('#confirm-delete').disabled = true;
  try { await api(`/api/subtitles/${pendingDelete}`, { method: 'DELETE' }); $('#delete-dialog').close(); await loadLibrary(); toast('Titulky boli odstránené.'); }
  catch (error) { toast(error.message); }
  finally { $('#confirm-delete').disabled = false; }
});
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#settings-error').hidden = true; $('#save-settings').disabled = true;
  try { await api('/api/config', jsonOptions('PUT', { baseUrl: $('#base-url').value })); await loadConfig(); toast('Adresa servera je uložená.'); }
  catch (error) { showError('#settings-error', error); }
  finally { $('#save-settings').disabled = config.baseUrlLocked; }
});

async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else {
      const input = node('textarea'); input.value = value;
      const parent = $('#settings-dialog').open ? $('#settings-dialog') : document.body;
      parent.append(input); input.select();
      const copied = document.execCommand('copy'); input.remove(); if (!copied) throw new Error();
    }
    toast('Skopírované.');
  } catch { toast('Kopírovanie je nedostupné. Označ a skopíruj text ručne.'); }
}
$('#copy-command').addEventListener('click', () => copyText($('#tailscale-command').textContent));
$('#copy-addon').addEventListener('click', () => copyText($('#addon-url').value));
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#login-error').textContent = '';
  const button = $('#login-form button'); button.disabled = true;
  try { await api('/api/login', jsonOptions('POST', { password: $('#password').value })); $('#password').value = ''; await initialize(); }
  catch (error) { showError('#login-error', error); }
  finally { button.disabled = false; }
});
$('#logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); showLogin(); }
  catch (error) { toast(error.message); }
});
updateType(); initialize();
