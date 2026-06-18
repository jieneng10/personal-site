// ==================== Test Setup ====================
// Provides DOMParser (via JSDOM) and other browser APIs for Node.js testing.
// Called by vitest.config.js → setupFiles.

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'https://jieneng10.github.io/personal-site/',
});

// Expose browser APIs that our source code expects
global.DOMParser = dom.window.DOMParser;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
