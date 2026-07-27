import { isSocialUrl, isMapsUrl } from '../src/resolve/wrapper.js';

const TOKEN_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%()[\]]+/g;
const trimPunct = (value) => value.replace(/[.,;:!?]+$/, '');

// Social posts and Maps short links have opaque-id paths that never contain
// brackets, so anything from the first bracket on is glued caption text.
// Long-form google.com/maps URLs DO carry literal parens in place names;
// for those only trailing punctuation and a dangling opener are trimmed.
function cleanToken(token) {
  const beforeBracket = trimPunct(token.split(/[()[\]{}]/, 1)[0]);
  if (isSocialUrl(beforeBracket) || /^https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl)\//.test(beforeBracket)) {
    return beforeBracket;
  }
  return trimPunct(token).replace(/[([]+$/, '');
}

// LINE messages arrive as free text; share sheets usually append the URL
// after a caption, sometimes with CJK text glued right onto it. CJK never
// matches TOKEN_RE, so it ends the match; cleanToken handles the brackets
// and punctuation that chat prose leaves attached.
export function extractSupportedUrl(text) {
  for (const token of String(text || '').match(TOKEN_RE) || []) {
    const url = cleanToken(token);
    if (isSocialUrl(url) || isMapsUrl(url)) return url;
  }
  return '';
}
