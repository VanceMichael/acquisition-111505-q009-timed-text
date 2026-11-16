import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { interpretTtml } from '../src/ttml/interpret.mjs';

const fixture = name => readFile(new URL(`../fixtures/${name}`, import.meta.url));

test('intro：嵌套容器、区域分离与隐藏跨度按声明解释', async () => {
  const result = await interpretTtml(await fixture('intro.xml'));
  assert.equal(result.ok, true);
  assert.equal(result.timeBase.frameRate, 30);
  assert.equal(result.timeBase.effectiveFrameRate, 29.97002997);
  assert.equal(result.timeBase.tickRate, 1000);
  assert.equal(result.fragments.length, 3);

  const [left, rightSeq, rightPar] = result.fragments;
  assert.equal(left.region, 'left');
  assert.equal(left.text, '欢迎\n参观');
  assert.equal(left.searchText, '欢迎 参观');
  assert.deepEqual(left.timing, { status: 'resolved', begin: 1, end: 2.001, raw: { begin: null, end: null, dur: '30f' } });
  assert.equal(left.spans[0].style, 'hidden');
  assert.equal(left.spans[0].visibility, 'hidden');
  assert.ok(!left.text.includes('内部备注'));

  // body 偏移 1s + seq 衔接 30f(1.001s) + 500t(0.5s)
  assert.equal(rightSeq.region, 'right');
  assert.equal(rightSeq.text, '请往二号厅');
  assert.deepEqual([rightSeq.timing.begin, rightSeq.timing.end], [2.001, 2.501]);

  // 同一时刻不同区域的文字保持独立片段，绝不串句
  assert.equal(rightPar.region, 'right');
  assert.equal(rightPar.text, '右屏独立文字');
  assert.deepEqual([rightPar.timing.begin, rightPar.timing.end], [1, 3]);
  const overlaps = [left, rightPar].filter(item => item.timing.begin < 2 && item.timing.end > 1);
  assert.equal(overlaps.length, 2);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'hidden-content');

  // 时间依据链保留每一级继承偏移与原始表达式
  const paths = left.basis.map(item => item.path);
  assert.deepEqual(paths, ['/tt/body', '/tt/body/div', '/tt/body/div/p']);
  assert.equal(left.basis[0].begin, '1s');
  assert.equal(left.basis[1].timeContainer, 'seq');
});

test('conflict：矛盾时间约束保留原文与问题，不制造精确时刻且污染 seq 后续兄弟', async () => {
  const result = await interpretTtml(await fixture('conflict.xml'));
  const [left, rightSeq, rightPar] = result.fragments;
  assert.equal(left.timing.status, 'unresolved');
  assert.equal(left.timing.begin, null);
  assert.equal(left.timing.raw.begin, '4s');
  assert.equal(left.timing.raw.end, '2s');
  assert.ok(result.issues.some(issue => issue.code === 'contradictory-interval'));
  // seq 后续兄弟继承的偏移无法确定
  assert.equal(rightSeq.timing.status, 'unresolved');
  assert.ok(result.issues.some(issue => issue.code === 'seq-end-unresolved'));
  // 另一个 par 容器不受污染
  assert.equal(rightPar.timing.status, 'resolved');
  // 文字仍然保留，便于人工修订
  assert.equal(left.text, '欢迎\n参观');
});

test('只有样式没有正文的 span/p 不产生字幕', async () => {
  const result = await interpretTtml(await fixture('edge.xml'));
  const texts = result.fragments.map(item => item.text);
  assert.ok(!texts.some(text => text.trim() === ''));
  assert.ok(result.issues.some(issue => issue.code === 'empty-fragment'));
  const clock = result.fragments[0];
  assert.equal(clock.text, '时钟表达式文字');
  assert.deepEqual([clock.timing.begin, clock.timing.end], [1.5, 3]);
  // 开放区间：结束为 null 但状态仍是 resolved，不构成矛盾
  const open = result.fragments.find(item => item.text === '开放区间文字');
  assert.equal(open.timing.status, 'resolved');
  assert.equal(open.timing.end, null);
});

test('缺少帧率声明时帧表达式不套默认值，tick 与时钟仍可确定', async () => {
  const result = await interpretTtml(await fixture('no-framerate.xml'));
  const frame = result.fragments.find(item => item.text.includes('帧'));
  assert.equal(frame.timing.status, 'unresolved');
  assert.ok(result.issues.some(issue => issue.code === 'frame-expression-without-frame-rate'));
  const tick = result.fragments.find(item => item.text.includes('tick'));
  assert.deepEqual([tick.timing.begin, tick.timing.end], [0.5, null]);
});

test('外置样式可用时按其 display/visibility 取舍；不可用时保留问题', async () => {
  const raw = await fixture('external-styles.xml');
  const styles = await fixture('styles.xml');

  const loaded = await interpretTtml(raw, { externalStyles: [{ href: '/text/styles.xml', bytes: styles }] });
  // 右屏区域样式 external-hidden=visibility hidden -> 不采集；display:none 的备注也不采集
  assert.deepEqual(loaded.fragments.map(item => item.text), ['外置样式可见文字']);
  assert.ok(loaded.issues.some(issue => issue.code === 'display-none'));

  const missing = await interpretTtml(raw, { externalStyles: [{ href: '/text/missing.xml', bytes: null, reason: '来源返回 404' }] });
  assert.ok(missing.issues.some(issue => issue.code === 'external-style-unavailable'));
  assert.ok(missing.issues.some(issue => issue.code === 'unknown-style'));
  // 缺样式时不臆造隐藏：默认可见，文字全部保留并带问题
  assert.equal(missing.fragments.length, 2);
});

test('display:none 整棵跳过，visibility:hidden 允许可见后代复活', async () => {
  const xml = '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:frameRate="25"><head><styling><style xml:id="hide" tts:visibility="hidden"/><style xml:id="show" tts:visibility="visible"/><style xml:id="gone" tts:display="none"/></styling></head><body><div><p dur="1s"><span style="hide">隐藏<span style="show">复活文字</span></span></p><p dur="1s" style="gone">整段消失</p></div></body></tt>';
  const result = await interpretTtml(Buffer.from(xml));
  assert.equal(result.fragments.length, 1);
  assert.equal(result.fragments[0].text, '复活文字');
  assert.ok(result.issues.some(issue => issue.code === 'display-none'));
});

test('格式损坏与非 TTML 根返回结构化问题而非抛异常', async () => {
  const malformed = await interpretTtml(Buffer.from('<tt xmlns="x"><p>未闭合'));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.issues[0].code, 'malformed-xml');
  const other = await interpretTtml(Buffer.from('<html xmlns="x"/>'));
  assert.equal(other.issues[0].code, 'not-ttml');
});
