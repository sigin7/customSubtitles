import { createHash } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const LANGUAGES = { slo: 'Slovak', cze: 'Czech', eng: 'English', hun: 'Hungarian', pol: 'Polish', ger: 'German', ukr: 'Ukrainian', spa: 'Spanish', fre: 'French' };
const extensions = new Set(['srt', 'vtt', 'ass', 'ssa']);
const clean = (value, max = 200) => String(value ?? '').trim().slice(0, max);

export function validateMetadata(fields) {
  const type = fields.type;
  const imdbId = clean(fields.imdbId).toLowerCase();
  if (!['movie', 'series'].includes(type)) throw new HttpError(400, 'Select a movie or series.');
  if (!/^tt\d{7,10}$/.test(imdbId)) throw new HttpError(400, 'Enter a valid IMDb ID, for example tt1375666.');
  const title = clean(fields.title);
  if (!title) throw new HttpError(400, 'Enter the movie or series title.');
  const lang = clean(fields.lang);
  if (!Object.hasOwn(LANGUAGES, lang)) throw new HttpError(400, 'Select a supported language.');
  let season = null, episode = null;
  if (type === 'series') {
    const s = String(fields.season ?? ''), e = String(fields.episode ?? '');
    if (!/^\d{1,3}$/.test(s) || !/^\d{1,4}$/.test(e) || Number(e) < 1) throw new HttpError(400, 'A series requires a season (0 or greater) and episode (1 or greater).');
    season = Number(s); episode = Number(e);
  }
  return { type, imdbId, title, lang, season, episode, videoId: type === 'movie' ? imdbId : `${imdbId}:${season}:${episode}`, label: clean(fields.label, 120) };
}

export function decodeSubtitle(bytes, encoding = 'auto') {
  if (!['auto', 'utf-8', 'windows-1250', 'windows-1252', 'utf-16le', 'utf-16be'].includes(encoding)) throw new HttpError(400, 'Unsupported encoding.');
  let text;
  try {
    if (encoding !== 'auto') text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    else {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { text = new TextDecoder('windows-1250', { fatal: true }).decode(bytes); }
    }
  } catch { throw new HttpError(400, 'The file could not be decoded. Select the correct encoding.'); }
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new HttpError(400, 'Upload a text subtitle file.');
  return text;
}

export function prepareSubtitle(filename, bytes, encoding) {
  const originalName = clean(filename.replace(/\\/g, '/').split('/').pop(), 240);
  const extension = originalName.split('.').pop().toLowerCase();
  if (!extensions.has(extension)) throw new HttpError(400, 'Supported formats are .srt, .vtt, .ass, and .ssa.');
  if (bytes.length > 10 * 1024 * 1024) throw new HttpError(413, 'The maximum file size is 10 MB.');
  const text = decodeSubtitle(bytes, encoding);
  const valid = ['srt', 'vtt'].includes(extension)
    ? /\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3}\s+-->\s+\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3}/.test(text) && (extension !== 'vtt' || /^WEBVTT(?:\s|$)/.test(text))
    : /\[Events\]/i.test(text) && /^Dialogue\s*:/im.test(text);
  if (!valid) throw new HttpError(400, 'The file has an invalid subtitle format or contains no timed cues.');
  const content = Buffer.from(text, 'utf8');
  return { originalName, extension, content, bytes: content.length, hash: createHash('sha256').update(content).digest('hex') };
}

export function filenameHints(filename) {
  const episode = filename.match(/S(\d{1,3})E(\d{1,4})/i) ?? filename.match(/(?:^|[. _-])(\d{1,3})x(\d{1,4})/i);
  const imdb = filename.match(/tt\d{7,10}/i);
  const language = filename.match(/(?:^|[. _-])(sk|slo|slk|cs|cz|cze|ces|en|eng)(?=[. _-]|$)/i)?.[1]?.toLowerCase();
  return { season: episode ? Number(episode[1]) : null, episode: episode ? Number(episode[2]) : null, imdbId: imdb?.[0]?.toLowerCase() ?? '', lang: ({ sk: 'slo', slo: 'slo', slk: 'slo', cs: 'cze', cz: 'cze', cze: 'cze', ces: 'cze', en: 'eng', eng: 'eng' })[language] ?? '' };
}
