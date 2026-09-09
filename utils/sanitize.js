// Small dependency-free HTML allow-list sanitizer for trusted CMS content.
// Blog authors may use basic formatting, but active content and unsafe URLs are removed.
const ALLOWED_TAGS = new Set([
  'p','br','strong','b','em','i','u','s','blockquote','ul','ol','li',
  'h2','h3','h4','a','img','code','pre','hr'
]);
const GLOBAL_ATTRS = new Set(['title']);
const TAG_ATTRS = {
  a: new Set(['href','title','target','rel']),
  img: new Set(['src','alt','title','width','height'])
};

function safeUrl(value, { image = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw, 'https://example.invalid');
    if (u.origin === 'https://example.invalid') {
      return raw.startsWith('/') && !raw.startsWith('//') ? raw : null;
    }
    const protocol = u.protocol.toLowerCase();
    if (image) return ['https:','http:'].includes(protocol) ? u.href : null;
    return ['https:','http:'].includes(protocol) ? u.href : null;
  } catch (_) { return null; }
}

function sanitizeHtml(input) {
  let html = String(input || '');
  // Remove dangerous element blocks including their contents.
  html = html.replace(/<(script|style|iframe|object|embed|form|svg|math)[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  return html.replace(/<\/?[A-Za-z][^>]*>/g, (tag) => {
    const closing = /^<\//.test(tag);
    const match = /^<\/?\s*([A-Za-z0-9]+)([\s\S]*?)\/?\s*>$/.exec(tag);
    if (!match) return '';
    const name = match[1].toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return '';
    if (closing) return `</${name}>`;
    if (name === 'br' || name === 'hr') return `<${name}>`;

    const attrs = [];
    const attrSource = match[2] || '';
    const allowed = TAG_ATTRS[name] || new Set();
    const attrRe = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = attrRe.exec(attrSource))) {
      const attr = m[1].toLowerCase();
      if (!allowed.has(attr) && !GLOBAL_ATTRS.has(attr)) continue;
      if (attr.startsWith('on') || attr === 'style' || attr === 'srcdoc') continue;
      const value = m[2] ?? m[3] ?? m[4] ?? '';
      if (attr === 'href') {
        const url = safeUrl(value);
        if (!url) continue;
        attrs.push(`href="${escapeAttr(url)}"`);
      } else if (attr === 'src') {
        const url = safeUrl(value, { image: true });
        if (!url) continue;
        attrs.push(`src="${escapeAttr(url)}"`);
      } else if (attr === 'target') {
        if (!['_blank','_self','_parent','_top'].includes(value)) continue;
        attrs.push(`target="${escapeAttr(value)}"`);
      } else if (attr === 'rel') {
        const rel = value.split(/\s+/).filter(x => ['noopener','noreferrer','nofollow'].includes(x)).join(' ');
        if (rel) attrs.push(`rel="${escapeAttr(rel)}"`);
      } else if (/^(width|height)$/.test(attr)) {
        if (!/^\d{1,4}$/.test(value)) continue;
        attrs.push(`${attr}="${value}"`);
      } else {
        attrs.push(`${attr}="${escapeAttr(value)}"`);
      }
    }
    return `<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  });
}

function escapeAttr(value) {
  return String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

module.exports = { sanitizeHtml };
