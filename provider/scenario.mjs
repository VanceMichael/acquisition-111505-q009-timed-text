export const initialState = () => ({ name: '展陈字幕资料', revision: 1, mode: 'intro' });

import { readFile } from 'node:fs/promises';

const DOCUMENTS = {
  intro: { id: 'intro', file: 'intro.xml', styles: [] },
  conflict: { id: 'intro', file: 'conflict.xml', styles: [] },
  external: { id: 'external-demo', file: 'external-styles.xml', styles: [{ id: 'partner-style', href: '/text/styles.xml' }] },
  missingStyle: { id: 'external-demo', file: 'external-styles.xml', styles: [{ id: 'partner-style', href: '/text/missing-styles.xml' }] },
};

export async function handle({ url, state, json, bytes }) {
  const mode = DOCUMENTS[state.mode] ? state.mode : 'intro';
  const document = DOCUMENTS[mode];
  if (url.pathname === '/subtitles') {
    json(200, [{ id: document.id, revision: state.revision, href: `/text/${document.file}`, styles: document.styles }]);
    return true;
  }
  if (url.pathname === '/text/intro.xml' || url.pathname === '/text/conflict.xml') {
    bytes(200, await readFile(new URL(mode === 'conflict' ? '../fixtures/conflict.xml' : '../fixtures/intro.xml', import.meta.url)), 'application/ttml+xml');
    return true;
  }
  if (url.pathname === '/text/external-styles.xml') {
    bytes(200, await readFile(new URL('../fixtures/external-styles.xml', import.meta.url)), 'application/ttml+xml');
    return true;
  }
  if (url.pathname === '/text/styles.xml') {
    bytes(200, await readFile(new URL('../fixtures/styles.xml', import.meta.url)), 'application/ttml+xml');
    return true;
  }
  if (url.pathname === '/text/missing-styles.xml') {
    json(404, { error: '样式资源未交付' });
    return true;
  }
  return false;
}
