import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';
async function withSource(context) {
  const service = createProvider(); service.listen(0, '127.0.0.1'); await once(service, 'listening');
  context.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
  const base = `http://127.0.0.1:${service.address().port}`;
  const control = value => fetch(base + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const post = (path, value) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { base, control, post };
}

test('字幕保留时基倍率、顺序容器及隐藏跨度', async context => {
  const { base } = await withSource(context); const response = await fetch(base + '/text/intro.xml'); const xml = await response.text();
  assert.equal(response.headers.get('content-type'), 'application/ttml+xml'); assert.match(xml, /1000 1001/); assert.match(xml, /timeContainer="seq"/); assert.match(xml, /内部备注/); assert.match(xml, /region="right"/);
});
test('时间冲突以真实原文交付而非预先修正', async context => {
  const { base, control } = await withSource(context); await control({ mode: 'conflict' });
  assert.match(await (await fetch(base + '/text/intro.xml')).text(), /begin="4s" end="2s"/);
});
