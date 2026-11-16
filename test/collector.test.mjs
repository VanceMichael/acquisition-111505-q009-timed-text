import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
import { collectOnce } from '../src/collector.mjs';
import { Archive } from '../src/archive.mjs';

async function pair(context) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  const intake = await createIntake(directory);
  const provider = createProvider();
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  context.after(async () => {
    intake.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    intakeBase: `http://127.0.0.1:${intake.address().port}`,
    sourceBase: `http://127.0.0.1:${provider.address().port}`,
    control: value => fetch(`http://127.0.0.1:${provider.address().port}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }),
  };
}

test('采集：原始字节与解释结果共同归档，区域文字保持独立', async context => {
  const { directory, sourceBase } = await pair(context);
  const archive = await new Archive(directory).initialize();
  const run = await collectOnce(archive, sourceBase);
  assert.equal(run.ok, true);
  assert.equal(run.documents.length, 1);
  const document = run.documents[0];
  assert.equal(document.id, 'intro');
  assert.equal(document.fragmentCount, 3);
  assert.equal(document.duplicate, false);

  // 原始字节可凭摘要回查
  const raw = await archive.bytes(document.rawSha256);
  assert.match(raw.toString('utf8'), /timeContainer="seq"/);

  // 收据里保存完整解释与清单来源
  const records = await archive.list();
  const collectorRecords = records.filter(item => item.source === 'collector');
  assert.equal(collectorRecords.length, 1);
  const version = collectorRecords[0].versions[0];
  assert.equal(version.data.interpretation.fragments[0].text, '欢迎\n参观');
  assert.equal(version.data.manifest.href, '/text/intro.xml');
  assert.equal(version.sha256, document.rawSha256);
});

test('重复采集复用版本，修订交付保留新版本且旧讲解稿不被污染', async context => {
  const { directory, sourceBase, control } = await pair(context);
  const archive = await new Archive(directory).initialize();
  const first = await collectOnce(archive, sourceBase);
  assert.equal(first.documents[0].version, 1);
  const again = await collectOnce(archive, sourceBase);
  assert.equal(again.documents[0].duplicate, true);
  assert.equal(again.documents[0].version, 1);

  await control({ mode: 'conflict' });
  const revised = await collectOnce(archive, sourceBase);
  assert.equal(revised.documents[0].duplicate, false);
  assert.equal(revised.documents[0].version, 2);
  const [record] = (await archive.list()).filter(item => item.source === 'collector');
  assert.equal(record.versions.length, 2);
  assert.equal(record.versions[0].data.interpretation.fragments[0].timing.status, 'resolved');
  assert.equal(record.versions[1].data.interpretation.fragments[0].timing.status, 'unresolved');
});

test('冲突情景：问题随解释结果保留，不套默认帧率', async context => {
  const { directory, sourceBase, control } = await pair(context);
  await control({ mode: 'conflict' });
  const archive = await new Archive(directory).initialize();
  const run = await collectOnce(archive, sourceBase);
  const codes = run.documents[0].issues.map(issue => issue.code);
  assert.ok(codes.includes('contradictory-interval'));
  assert.ok(codes.includes('seq-end-unresolved'));
  assert.ok(!codes.includes('frame-expression-without-frame-rate'));
});

test('外置样式：授权 href 生效；授权但取不到时保留问题且文字不臆造隐藏', async context => {
  const { directory, sourceBase, control } = await pair(context);
  const archive = await new Archive(directory).initialize();

  await control({ mode: 'external' });
  const loaded = await collectOnce(archive, sourceBase);
  assert.equal(loaded.documents[0].fragmentCount, 1);
  assert.equal(loaded.documents[0].issueCount, 2); // display-none + empty-fragment

  await control({ mode: 'missingStyle' });
  const missing = await collectOnce(archive, sourceBase);
  const codes = missing.documents[0].issues.map(issue => issue.code);
  assert.ok(codes.includes('external-style-unavailable'));
  assert.ok(codes.includes('unknown-style'));
  assert.equal(missing.documents[0].fragmentCount, 2);
});

test('HTTP 入口：采集、查询与原始字节回查串通，人工与自动来源隔离', async context => {
  const { intakeBase, sourceBase } = await pair(context);
  const collected = await fetch(intakeBase + '/api/collect', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: sourceBase }),
  });
  assert.equal(collected.status, 200);
  const body = await collected.json();
  assert.equal(body.documents[0].fragmentCount, 3);

  const collections = await (await fetch(intakeBase + '/api/collections')).json();
  assert.equal(collections.length, 1);
  assert.equal(collections[0].source, 'collector');

  const raw = await fetch(intakeBase + `/api/raw/${body.documents[0].rawSha256}`);
  assert.equal(raw.status, 200);
  assert.match(await raw.text(), /欢迎/);
  assert.equal((await fetch(intakeBase + '/api/raw/deadbeef')).status, 404);

  // 人工入口数据不与采集记录混淆
  const manual = await fetch(intakeBase + '/api/manual', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: 'intro', region: 'left', begin: '0', text: '人工记录' }),
  });
  assert.equal(manual.status, 201);
  assert.equal((await (await fetch(intakeBase + '/api/collections')).json()).length, 1);
  assert.equal((await (await fetch(intakeBase + '/api/records')).json()).length, 2);
});

test('跨源 href 被拒绝，探查失败返回结构化错误', async context => {
  const { directory } = await pair(context);
  const archive = await new Archive(directory).initialize();
  const badProbe = await collectOnce(archive, 'http://127.0.0.1:9', '/subtitles');
  assert.equal(badProbe.ok, false);
  assert.equal(badProbe.stage, 'probe');
});
