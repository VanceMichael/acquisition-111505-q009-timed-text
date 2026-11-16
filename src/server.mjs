import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.mjs';
import { receiveManual } from './intake.mjs';
import { collectOnce } from './collector.mjs';

const DEFAULT_SOURCE = process.env.SOURCE_URL || `http://127.0.0.1:${Number(process.env.SOURCE_PORT || 4200)}`;

export async function createIntake(directory) {
  const archive = await new Archive(directory).initialize();
  return createServer(async (incoming, outgoing) => {
    const reply = (status, body) => { outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); outgoing.end(JSON.stringify(body)); };
    try {
      if (incoming.method === 'GET' && incoming.url === '/health') return reply(200, { status: 'ok', acquisition: ['manual', 'collector'] });
      if (incoming.method === 'GET' && incoming.url === '/api/records') return reply(200, await archive.list());
      if (incoming.method === 'GET' && incoming.url === '/api/collections') {
        const records = (await archive.list()).filter(item => item.source === 'collector');
        return reply(200, records);
      }
      const rawMatch = /^\/api\/raw\/([0-9a-f]{64})$/.exec(incoming.url ?? '');
      if (incoming.method === 'GET' && rawMatch) {
        try {
          const bytes = await archive.bytes(rawMatch[1]);
          outgoing.writeHead(200, { 'content-type': 'application/octet-stream' });
          return outgoing.end(bytes);
        } catch (error) { return reply(404, { error: error.message }); }
      }
      if (incoming.method === 'POST' && incoming.url === '/api/collect') {
        const chunks = []; let length = 0;
        for await (const chunk of incoming) { length += chunk.length; if (length > 65536) return reply(413, { error: '请求体过大' }); chunks.push(chunk); }
        let payload = {};
        if (length) { try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: 'JSON 无效' }); } }
        let source = DEFAULT_SOURCE;
        if (payload.source) {
          try {
            const candidate = new URL(payload.source);
            if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') throw new Error('仅支持 http/https 来源');
            source = candidate.origin;
          } catch (error) { return reply(422, { error: `来源地址无效：${error.message}` }); }
        }
        const result = await collectOnce(archive, source, payload.probePath || '/subtitles');
        return reply(result.ok ? 200 : 502, result);
      }
      if (incoming.method === 'POST' && incoming.url === '/api/manual') {
        const chunks = []; let length = 0;
        for await (const chunk of incoming) { length += chunk.length; if (length > 1048576) return reply(413, { error: '单份人工收件过大' }); chunks.push(chunk); }
        let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: 'JSON 无效' }); }
        try { return reply(201, await receiveManual(archive, payload)); } catch (error) { return reply(422, { error: error.message }); }
      }
      return reply(404, { error: '路径不存在' });
    } catch (error) { return reply(500, { error: error.message }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
  service.listen(Number(process.env.PORT || 3200), '0.0.0.0', () => console.log('收件服务已就绪'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => service.close(() => process.exit(0)));
}
