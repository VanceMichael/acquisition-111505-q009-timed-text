export const initialState = () => ({ name: '展陈字幕资料', revision: 1 });

import { readFile } from 'node:fs/promises';
export async function handle({ url, state, json, bytes }) {
  if (url.pathname === '/subtitles') { json(200, [{ id: 'intro', revision: state.revision, href: '/text/intro.xml' }]); return true; }
  if (url.pathname === '/text/intro.xml') { bytes(200, await readFile(new URL(state.conflict ? '../fixtures/conflict.xml' : '../fixtures/intro.xml', import.meta.url)), 'application/ttml+xml'); return true; }
  return false;
}
