import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const intake = await createIntake(directory); const provider = createProvider();
try {
  intake.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
  await Promise.all([once(intake, 'listening'), once(provider, 'listening')]);
  const base = `http://127.0.0.1:${intake.address().port}`;
  const source = `http://127.0.0.1:${provider.address().port}`;
  const control = value => fetch(source + '/__control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const sample = JSON.parse(await readFile(new URL('../fixtures/manual.json', import.meta.url), 'utf8'));

  const run = async (label, mode) => {
    if (mode) await control({ mode });
    const response = await fetch(base + '/api/collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) });
    const summary = await response.json();
    for (const document of summary.documents ?? []) {
      console.log(JSON.stringify({ 演示: label, 文档: document.id, 片段: document.fragmentCount, 问题: document.issueCount, 版本: document.version, 重复: document.duplicate, 失败原因: document.error ?? null }));
    }
    return summary;
  };

  await run('正常交付（分区/嵌套计时/隐藏跨度）', 'intro');
  const collections = await (await fetch(base + '/api/collections')).json();
  const first = collections[0].versions[0].data.interpretation;
  for (const fragment of first.fragments) {
    console.log(JSON.stringify({ 区域: fragment.region, 文字: fragment.text.replace('\n', '\\n'), 时间: fragment.timing }));
  }
  console.log(JSON.stringify({ 时间基: first.timeBase.declared, 有效帧率: first.timeBase.effectiveFrameRate }));

  await run('重复交付应复用版本', 'intro');
  await run('矛盾时间约束保留问题而非制造时刻', 'conflict');
  await run('授权外置样式生效', 'external');
  await run('外置样式不可得时保留问题', 'missingStyle');

  const revised = await (await fetch(base + '/api/collections')).json();
  const introRecord = revised.find(item => item.identity.document === 'intro');
  console.log(JSON.stringify({ intro版本数: introRecord.versions.length, 旧版首片段状态: introRecord.versions[0].data.interpretation.fragments[0].timing.status, 新版首片段状态: introRecord.versions.at(-1).data.interpretation.fragments[0].timing.status }));

  const accepted = await fetch(base + '/api/manual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample) });
  console.log(JSON.stringify({ 人工收件: await accepted.json() }));
  const rawSha = introRecord.versions[0].sha256;
  const raw = await fetch(base + `/api/raw/${rawSha}`);
  console.log(JSON.stringify({ 原文回查: raw.status, 字节数: (await raw.arrayBuffer()).byteLength, 摘要: rawSha }));
  console.log(JSON.stringify({ 采集记录: (await (await fetch(base + '/api/collections')).json()).length, 全部记录: (await (await fetch(base + '/api/records')).json()).length }));
} finally { intake.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(resolve => intake.close(resolve)), new Promise(resolve => provider.close(resolve))]); await rm(directory, { recursive: true, force: true }); }
