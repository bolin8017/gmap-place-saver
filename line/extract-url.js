import { isSocialUrl, isMapsUrl } from '../src/resolve/wrapper.js';

// LINE messages arrive as free text; share sheets usually append the URL
// after a caption, sometimes with CJK text glued right onto it. Match only
// RFC 3986 URL characters (which excludes CJK), then trim trailing ASCII
// punctuation that chat prose leaves attached.
export function extractSupportedUrl(text) {
  const tokens = String(text || '').match(/https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g) || [];
  for (const token of tokens) {
    const url = token.replace(/[)\].,;:!?'"]+$/, '');
    if (isSocialUrl(url) || isMapsUrl(url)) return url;
  }
  return '';
}
