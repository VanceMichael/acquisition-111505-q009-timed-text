import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretTtml } from '../src/ttml/interpret.mjs';

const wrap = (inner, params = 'ttp:frameRate="10" ttp:tickRate="100"') =>
  `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xmlns:tts="http://www.w3.org/ns/ttml#styling" ${params}>${inner}</tt>`;

test('seq 容器按前一兄弟结束点衔接，end 相对顺序容器起点', async () => {
  const xml = wrap('<body begin="2s"><div timeContainer="seq"><p dur="1s">第一句</p><p begin="0.5s" dur="1s">第二句</p><p end="6s">第三句</p></div></body>');
  const { fragments } = await interpretTtml(Buffer.from(xml));
  // 第三句 begin 衔接前一句结束 4.5；end=6s 相对 seq 起点 2s -> 8
  assert.deepEqual(fragments.map(item => [item.timing.begin, item.timing.end]), [[2, 3], [3.5, 4.5], [4.5, 8]]);
});

test('span 自身 begin/dur 相对 p 起点，记录在 span 计时依据中', async () => {
  const xml = wrap('<body><div timeContainer="par"><p begin="1s" dur="4s"><span begin="1s" dur="2s">跨度文字</span></p></div></body>');
  const { fragments } = await interpretTtml(Buffer.from(xml));
  assert.equal(fragments[0].timing.begin, 1);
  assert.equal(fragments[0].spans[0].timing.begin, 2);
  assert.equal(fragments[0].spans[0].timing.end, 4);
  assert.equal(fragments[0].spans[0].timing.raw.dur, '2s');
});

test('区域沿祖先继承，未知区域保留问题且不丢弃文字', async () => {
  const xml = wrap('<body region="left"><div><p dur="1s">继承区域文字</p></div><p dur="1s" region="ghost">未知区域文字</p></body>');
  const result = await interpretTtml(Buffer.from(xml));
  assert.equal(result.fragments[0].region, 'left');
  assert.equal(result.fragments[1].region, 'ghost');
  assert.equal(result.fragments[1].regionResolved, false);
  assert.ok(result.issues.some(issue => issue.code === 'unknown-region'));
});

test('样式引用循环被识别，不无限递归', async () => {
  const xml = wrap('<head><styling><style xml:id="a" style="b" tts:visibility="visible"/><style xml:id="b" style="a"/></styling></head><body><div><p dur="1s" style="a">循环样式文字</p></div></body>');
  const result = await interpretTtml(Buffer.from(xml));
  assert.equal(result.fragments.length, 1);
  assert.ok(result.issues.some(issue => issue.code === 'style-cycle'));
});

test('end 与 dur 同时出现时 end 优先并登记问题', async () => {
  const xml = wrap('<body><div timeContainer="par"><p begin="0s" end="3s" dur="9s">文字</p></div></body>');
  const result = await interpretTtml(Buffer.from(xml));
  assert.equal(result.fragments[0].timing.end, 3);
  assert.ok(result.issues.some(issue => issue.code === 'end-and-dur'));
});

test('帧率倍率按文档声明做有理精确换算，不产生浮点漂移', async () => {
  const xml = wrap('<body><div timeContainer="par"><p dur="30f">帧文字</p></div></body>', 'ttp:frameRate="30" ttp:frameRateMultiplier="1000 1001" ttp:tickRate="1000"');
  const { fragments, timeBase } = await interpretTtml(Buffer.from(xml));
  assert.equal(timeBase.effectiveFrameRate, 29.97002997);
  assert.equal(fragments[0].timing.end, 1.001);
});

test('无法解析的时间表达式登记问题并使片段时刻不可确定', async () => {
  const xml = wrap('<body><div timeContainer="par"><p begin="稍后" dur="1s">文字</p></div></body>');
  const result = await interpretTtml(Buffer.from(xml));
  assert.equal(result.fragments[0].timing.status, 'unresolved');
  assert.ok(result.issues.some(issue => issue.code === 'unparseable-time-expression'));
});

test('seq 中游表达式不可解析时，后续兄弟的继承时刻一并不可确定', async () => {
  const xml = wrap('<body><div timeContainer="seq"><p dur="1s">第一步</p><p dur="坏">第二步</p><p dur="1s">第三步</p></div></body>');
  const result = await interpretTtml(Buffer.from(xml));
  assert.equal(result.fragments[0].timing.status, 'resolved');
  assert.equal(result.fragments[1].timing.status, 'unresolved');
  assert.equal(result.fragments[2].timing.status, 'unresolved');
  assert.ok(result.issues.some(issue => issue.code === 'unparseable-time-expression'));
  assert.ok(result.issues.some(issue => issue.code === 'seq-end-unresolved'));
});

test('帧率声明非法时帧表达式不可确定，不回落默认帧率；tick 仍可计算', async () => {
  const xml = '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:frameRate="零" ttp:tickRate="100"><body><div timeContainer="par"><p begin="5f" dur="10f">帧文字</p><p begin="50t">tick 文字</p></div></body></tt>';
  const result = await interpretTtml(Buffer.from(xml));
  assert.ok(result.issues.some(issue => issue.code === 'invalid-timebase'));
  const frame = result.fragments.find(item => item.text.includes('帧'));
  assert.equal(frame.timing.status, 'unresolved');
  assert.ok(result.issues.some(issue => issue.code === 'frame-expression-with-invalid-timebase'));
  const tick = result.fragments.find(item => item.text.includes('tick'));
  assert.equal(tick.timing.status, 'resolved');
  assert.equal(tick.timing.begin, 0.5);
});

test('不同区域同一时刻的片段各自独立，片段顺序遵循文档顺序', async () => {
  const xml = wrap('<head><layout><region xml:id="left"/><region xml:id="right"/></layout></head><body><div timeContainer="par"><p region="left" begin="0s" dur="2s">左屏</p><p region="right" begin="0s" dur="2s">右屏</p></div></body>');
  const { fragments } = await interpretTtml(Buffer.from(xml));
  assert.deepEqual(fragments.map(item => item.text), ['左屏', '右屏']);
  assert.notEqual(fragments[0].region, fragments[1].region);
  // 没有任何片段把两个区域的文字串成一句
  assert.ok(fragments.every(item => item.text.length === 2));
});
