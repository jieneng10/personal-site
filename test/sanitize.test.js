// ==================== sanitizeHtml — XSS Vector Tests ====================
// Tests the HTML sanitizer that is the last line of defense against XSS.
// Source: js/articles.js (function sanitizeHtml + _walkSanitize + _BLOCKED_TAGS)

import { describe, it, expect } from 'vitest';

// ---- Clone the production sanitizer into the test ----
// (Stage 0: copy-paste to avoid restructuring source. Stage 1 → proper import.)

const _BLOCKED_TAGS = {
  script: 1, iframe: 1, object: 1, embed: 1, applet: 1, link: 1, style: 1,
  meta: 1, base: 1, form: 1, input: 1, textarea: 1, button: 1, select: 1, option: 1,
};

function _walkSanitize(node) {
  if (node.nodeType === 3) return; // text node — keep
  if (node.nodeType !== 1) { node.parentNode && node.parentNode.removeChild(node); return; }

  const tag = node.tagName.toLowerCase();
  if (_BLOCKED_TAGS[tag]) { node.parentNode && node.parentNode.removeChild(node); return; }

  const attrs = node.attributes;
  if (attrs) {
    for (let i = attrs.length - 1; i >= 0; i--) {
      const aname = attrs[i].name.toLowerCase();
      // Event handlers
      if (/^on\w+/.test(aname)) { node.removeAttribute(aname); continue; }
      const aval = attrs[i].value || '';
      if (/^\s*javascript\s*:/i.test(aval)) { node.removeAttribute(aname); continue; }
      if (
        (aname === 'href' || aname === 'src' || aname === 'action' || aname === 'formaction') &&
        /^\s*javascript\s*:/i.test(aval)
      ) {
        node.removeAttribute(aname);
      }
    }
  }

  const children = Array.prototype.slice.call(node.childNodes);
  for (let j = 0; j < children.length; j++) {
    _walkSanitize(children[j]);
  }
}

function sanitizeHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    _walkSanitize(doc.body);
    return doc.body.innerHTML;
  } catch (e) {
    return String(html).replace(/<[^>]*>/g, '');
  }
}

// ================================================================
// Tests
// ================================================================

describe('sanitizeHtml', () => {
  // ---- Harmless content (must pass through) ----
  it('should keep plain text unchanged', () => {
    expect(sanitizeHtml('Hello world')).toBe('Hello world');
  });

  it('should keep safe HTML tags', () => {
    const input = '<p>Hello <strong>world</strong></p>';
    const result = sanitizeHtml(input);
    expect(result).toContain('<p>');
    expect(result).toContain('<strong>world</strong>');
  });

  it('should keep markdown-rendered headings and lists', () => {
    const input = '<h2>Title</h2><ul><li>Item 1</li><li>Item 2</li></ul>';
    const result = sanitizeHtml(input);
    expect(result).toContain('<h2>Title</h2>');
    expect(result).toContain('<li>Item 1</li>');
  });

  it('should keep images with safe src', () => {
    const input = '<img src="https://example.com/cover.jpg" alt="cover">';
    const result = sanitizeHtml(input);
    expect(result).toContain('src="https://example.com/cover.jpg"');
    expect(result).toContain('alt="cover"');
  });

  // ---- Script injection (must block) ----
  it('should remove <script> tags', () => {
    const input = '<p>Hi</p><script>alert("xss")</script><p>Bye</p>';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('alert');
    expect(result).toContain('<p>Hi</p>');
    expect(result).toContain('<p>Bye</p>');
  });

  it('should remove <iframe> tags', () => {
    const input = '<div>Hi</div><iframe src="https://evil.com"></iframe>';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('iframe');
    expect(result).not.toContain('evil.com');
  });

  it('should remove <object> and <embed> tags', () => {
    const input = '<object data="evil.swf"></object><embed src="evil.swf">';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('object');
    expect(result).not.toContain('embed');
  });

  // ---- Event handler injection (must strip) ----
  it('should strip onclick attributes', () => {
    const input = '<img src="x.jpg" onclick="stealCookies()">';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('onclick');
    expect(result).toContain('src="x.jpg"');
  });

  it('should strip onerror attributes', () => {
    const input = '<img src="x" onerror="alert(1)">';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('alert(1)');
  });

  it('should strip onload / onmouseover / onfocus', () => {
    const cases = [
      '<body onload="evil()">',
      '<div onmouseover="evil()">text</div>',
      '<input onfocus="evil()">',
    ];
    for (const input of cases) {
      const result = sanitizeHtml(input);
      expect(result).not.toContain('onload');
      expect(result).not.toContain('onmouseover');
      expect(result).not.toContain('onfocus');
    }
  });

  // ---- javascript: URL injection (must strip) ----
  it('should strip javascript: URLs from href', () => {
    const input = '<a href="javascript:alert(1)">click me</a>';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('javascript:');
    expect(result).toContain('click me');
  });

  it('should strip javascript: URLs from src', () => {
    const input = '<img src="javascript:alert(1)">';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('javascript:');
  });

  it('should strip obfuscated javascript: (with spaces)', () => {
    const input = '<a href=" javascript:alert(1) ">click</a>';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('javascript:');
  });

  it('should strip javascript: from formaction', () => {
    const input = '<button formaction="javascript:evil()">go</button>';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('javascript:');
  });

  // ---- Nested / recursive threats ----
  it('should strip nested malicious tags', () => {
    const input = '<div><p>text<script>alert(1)</script></p></div>';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('script');
    expect(result).toContain('text');
  });

  it('should handle empty input', () => {
    expect(sanitizeHtml('')).toBe('');
  });

  it('should handle null/undefined without throwing', () => {
    expect(() => sanitizeHtml(null)).not.toThrow();
    expect(() => sanitizeHtml(undefined)).not.toThrow();
  });

  // ---- Encoding tricks ----
  it('should handle HTML entities', () => {
    const input = '&lt;script&gt;alert(1)&lt;/script&gt;';
    const result = sanitizeHtml(input);
    // Should be harmless (already entity-encoded), kept as text
    expect(result).toContain('&lt;');
  });

  // ---- CSS / style injection ----
  it('should remove <style> tags', () => {
    const input = '<style>body { display: none; }</style><p>visible</p>';
    const result = sanitizeHtml(input);
    expect(result).not.toContain('style');
    expect(result).toContain('visible');
  });
});
