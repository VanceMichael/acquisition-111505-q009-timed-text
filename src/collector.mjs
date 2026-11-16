// 定时文本自动采集：探查合作方清单 -> 抓取授权资源 -> 原始字节先行归档 ->
// 按 TTML 声明解释 -> 解释结果与原始摘要共同入档，旧版本不被覆盖。

import { request, decodeJson } from './transport.mjs';
import { interpretTtml } from './ttml/interpret.mjs';

const MAX_BYTES = 10 * 1024 * 1024;

export function resolveHref(base, href) {
  const baseUrl = new URL(base);
  const resolved = new URL(href, baseUrl);
  if (resolved.origin !== baseUrl.origin) {
    const error = new Error(`相对链接解析后跨源，拒绝抓取：${href}`);
    error.code = 'cross-origin-href';
    throw error;
  }
  return resolved;
}

async function fetchAuthorized(label, base, href) {
  let url;
  try { url = resolveHref(base, href); }
  catch (error) { return { href, bytes: null, reason: error.message, status: null }; }
  try {
    const reply = await request(url.href);
    if (reply.status < 200 || reply.status > 299) {
      return { href, bytes: null, reason: `来源返回 ${reply.status}`, status: reply.status };
    }
    if (reply.bytes.length > MAX_BYTES) {
      return { href, bytes: null, reason: '资源超过 10MB 上限', status: reply.status };
    }
    return { href, bytes: reply.bytes, contentType: reply.headers['content-type'] ?? null, status: reply.status, label };
  } catch (error) {
    return { href, bytes: null, reason: error.message, status: null };
  }
}

function validateManifest(manifest) {
  if (!Array.isArray(manifest)) throw new Error('清单应是交付数组');
  for (const item of manifest) {
    if (!item || typeof item !== 'object') throw new Error('清单条目应是对象');
    if (!item.id || typeof item.id !== 'string') throw new Error('清单条目缺少 id');
    if (!item.href || typeof item.href !== 'string') throw new Error(`条目 ${item.id} 缺少 href`);
    if (item.styles !== undefined && !Array.isArray(item.styles)) throw new Error(`条目 ${item.id} 的 styles 应是数组`);
  }
}

// 运行一次采集。archive：归档实例；sourceBase：来源根地址；probePath：探查路径。
export async function collectOnce(archive, sourceBase, probePath = '/subtitles') {
  let manifest;
  try {
    if (typeof probePath !== 'string' || !probePath.startsWith('/')) throw new Error('探查路径必须是来源内的绝对路径');
    const reply = await request(new URL(probePath, sourceBase).href);
    manifest = decodeJson(reply);
    validateManifest(manifest);
  } catch (error) {
    return { ok: false, stage: 'probe', error: error.message, documents: [] };
  }

  const documents = [];
  for (const entry of manifest) {
    const fetched = await fetchAuthorized(entry.id, sourceBase, entry.href);
    if (!fetched.bytes) {
      documents.push({ id: entry.id, revision: entry.revision ?? null, ok: false, error: fetched.reason, issues: [{ code: 'document-unavailable', path: entry.href, message: fetched.reason }] });
      continue;
    }
    const authorizedStyles = [];
    const externalIssues = [];
    for (const styleEntry of entry.styles ?? []) {
      if (!styleEntry || typeof styleEntry.href !== 'string') {
        externalIssues.push({ code: 'invalid-style-entry', path: entry.href, message: '清单中的样式条目缺少 href' });
        continue;
      }
      const loaded = await fetchAuthorized(styleEntry.id ?? styleEntry.href, sourceBase, styleEntry.href);
      if (!loaded.bytes) externalIssues.push({ code: 'external-style-unavailable', path: entry.href, message: loaded.reason, href: styleEntry.href, reason: loaded.reason });
      else authorizedStyles.push({ href: styleEntry.href, bytes: loaded.bytes });
    }

    let interpretation;
    try {
      interpretation = await interpretTtml(fetched.bytes, { externalStyles: authorizedStyles });
    } catch (error) {
      interpretation = { ok: false, fragments: [], timeBase: null, issues: [{ code: 'interpreter-failure', path: '/', message: error.message }] };
    }
    interpretation.issues = [...externalIssues, ...interpretation.issues];

    const identity = { document: entry.id };
    const data = {
      manifest: { id: entry.id, revision: entry.revision ?? null, href: entry.href, styles: (entry.styles ?? []).map(item => item?.href).filter(Boolean) },
      source: sourceBase,
      contentType: fetched.contentType,
      interpretation,
    };
    const receipt = await archive.accept('collector', identity, data, fetched.bytes);
    documents.push({
      id: entry.id,
      revision: entry.revision ?? null,
      ok: interpretation.ok,
      duplicate: receipt.duplicate,
      version: receipt.version,
      rawSha256: receipt.sha256,
      fragmentCount: interpretation.fragments.length,
      issueCount: interpretation.issues.length,
      issues: interpretation.issues,
      receipt: receipt.receipt,
    });
  }
  return { ok: true, stage: 'complete', source: sourceBase, collectedAt: new Date().toISOString(), documents };
}
