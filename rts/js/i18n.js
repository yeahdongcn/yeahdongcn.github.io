'use strict';
// ============================================================================
// NEON TURF — i18n.js  (presentation; no DOM needed, safe to load anywhere)
// Two languages, one switch. Content names live WITH the content: every def /
// faction / map carries {en, zh} objects -> NT.tr(obj). Interface strings live
// in string tables keyed by id -> NT.T('key', vars). Any file may contribute
// its own strings with NT.strings({ en: {...}, zh: {...} }).
// ============================================================================
NT.LANGS = ['en', 'zh'];
NT.lang = 'en';
NT.STR = { en: {}, zh: {} };

// Merge string tables. Later calls override earlier keys.
NT.strings = function (tables) {
  for (const lang in tables) {
    NT.STR[lang] = NT.STR[lang] || {};
    Object.assign(NT.STR[lang], tables[lang]);
  }
};

// Pick the current language from a {en, zh} object (falls back to en, then to '').
NT.tr = function (obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return obj[NT.lang] || obj.en || '';
};

// Interface string with {name} placeholders: NT.T('hud.credits', {n: 500}).
// Unknown keys come back as the key itself so missing strings are visible.
NT.T = function (key, vars) {
  let s = NT.STR[NT.lang] && NT.STR[NT.lang][key];
  if (s === undefined) s = NT.STR.en[key];
  if (s === undefined) return key;
  if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] === undefined ? m : vars[k]; });
  return s;
};

// Switch language; listeners of 'lang' re-render their text.
NT.setLang = function (lang) {
  if (NT.LANGS.indexOf(lang) < 0) lang = 'en';
  if (lang === NT.lang) return;
  NT.lang = lang;
  NT.emit('lang', lang);
};

// Best default for a browser locale string such as "zh-CN" or "en-US".
NT.guessLang = function (locale) { return /^zh\b/i.test(locale || '') ? 'zh' : 'en'; };
