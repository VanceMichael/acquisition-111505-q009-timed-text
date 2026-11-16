// TTML 子集解释器：按交付声明处理嵌套时间容器、区域与样式引用，
// 只保留真正可见的文字片段及其时间依据。
// 矛盾时间约束、缺失时基、外置样式不可得等情形登记到 issues，
// 不套用默认帧率制造精确时刻。

import { parseXml, XmlError, attr, childElements, findFirst } from './xml.mjs';
import { readTimeBase, parseExpression, toNumber, ZERO, add, cmp } from './time.mjs';

export const NS = {
  TT: 'http://www.w3.org/ns/ttml',
  TT_PARAMETER: 'http://www.w3.org/ns/ttml#parameter',
  TT_STYLING: 'http://www.w3.org/ns/ttml#styling',
  XML: 'http://www.w3.org/XML/1998/namespace',
};
const CONTENT = new Set(['body', 'div', 'p', 'span']);
const CONTAINERS = new Set(['body', 'div']);

function pathOf(element) {
  const segments = [];
  let current = element;
  while (current && current.type === 'element') {
    const id = attr(current, NS.XML, 'id');
    segments.unshift(id ? `${current.local}[#${id}]` : current.local);
    current = current.parent;
  }
  return '/' + segments.join('/');
}

export async function interpretTtml(raw, options = {}) {
  const issues = [];
  const note = (code, path, message, extra = {}) => issues.push({ code, path, message, ...extra });
  let document;
  try {
    document = parseXml(raw);
  } catch (error) {
    if (error instanceof XmlError) {
      return { ok: false, issues: [{ code: 'malformed-xml', path: '/', message: error.message }], fragments: [], timeBase: null };
    }
    throw error;
  }
  if (document.local !== 'tt' || document.ns !== NS.TT) {
    return { ok: false, issues: [{ code: 'not-ttml', path: pathOf(document), message: '根元素不是 TTML 的 tt 元素' }], fragments: [], timeBase: null };
  }

  const timeBase = readTimeBase(document, NS);
  for (const item of timeBase.notes) note(item.code, '/tt', `时间基声明无效：${item.field}="${item.expression}"`, { field: item.field, expression: item.expression });

  const head = findFirst(document, 'head', NS.TT);
  const styling = head ? findFirst(head, 'styling', NS.TT) : null;
  const layout = head ? findFirst(head, 'layout', NS.TT) : null;
  const body = findFirst(document, 'body', NS.TT);

  // ---- 样式表：本文档样式 + 已加载的外置样式；不可得的引用保留问题 ---------
  const styles = new Map();
  const externalStyles = options.externalStyles ?? [];
  for (const entry of externalStyles) {
    if (!entry.bytes) {
      note('external-style-unavailable', '/tt', `外置样式不可得：${entry.href}`, { href: entry.href, reason: entry.reason });
      continue;
    }
    let external;
    try { external = parseXml(entry.bytes); }
    catch (error) {
      note('external-style-unavailable', '/tt', `外置样式无法解析：${entry.href}`, { href: entry.href, reason: error.message });
      continue;
    }
    const extHead = findFirst(external, 'head', NS.TT);
    const extStyling = extHead ? findFirst(extHead, 'styling', NS.TT) : findFirst(external, 'styling', NS.TT);
    for (const style of childElements(extStyling ?? external, 'style', NS.TT)) registerStyle(style, styles, note, entry.href);
  }
  if (styling) for (const style of childElements(styling, 'style', NS.TT)) registerStyle(style, styles, note);

  // ---- 区域表 ---------------------------------------------------------------
  const regions = new Map();
  if (layout) {
    for (const region of childElements(layout, 'region', NS.TT)) {
      const id = attr(region, NS.XML, 'id');
      if (!id) { note('region-without-id', pathOf(region), 'region 缺少 xml:id，无法被引用'); continue; }
      if (regions.has(id)) note('duplicate-region', pathOf(region), `区域 ${id} 重复定义，采用首个定义`, { region: id });
      else regions.set(id, region);
    }
  }

  const styleChainMemo = new Map();
  const effectiveMemo = new Map();
  const timingMap = new Map();

  // 沿 style 引用链收集样式元素（含区域自带样式），检测循环与未知引用。
  function resolveStyleChain(element) {
    if (styleChainMemo.has(element)) return styleChainMemo.get(element);
    styleChainMemo.set(element, []); // 占位以阻断循环
    const chain = [];
    const refs = (attr(element, null, 'style') ?? '').split(/\s+/).filter(Boolean);
    const seen = new Set();
    const walk = ref => {
      if (seen.has(ref)) { note('style-cycle', pathOf(element), `样式引用存在循环：${ref}`, { style: ref }); return; }
      seen.add(ref);
      const target = styles.get(ref);
      if (!target) { note('unknown-style', pathOf(element), `引用的样式 ${ref} 不存在`, { style: ref }); return; }
      for (const parentRef of (attr(target, null, 'style') ?? '').split(/\s+/).filter(Boolean)) walk(parentRef);
      chain.push(target);
    };
    for (const ref of refs) walk(ref);
    styleChainMemo.set(element, chain);
    return chain;
  }

  // display / visibility 的生效值：被引用样式优先，其次元素自身，最后默认。
  function effectiveProperties(element, regionElement) {
    const memoKey = `${element === regionElement ? 'self' : ''}:${regionElement ? pathOf(regionElement) : ''}`;
    const bucket = effectiveMemo.get(element);
    if (bucket?.has(memoKey)) return bucket.get(memoKey);
    let display;
    let visibility;
    const consider = node => {
      if (!node) return;
      for (const chainNode of resolveStyleChain(node)) {
        display ??= attr(chainNode, NS.TT_STYLING, 'display');
        visibility ??= attr(chainNode, NS.TT_STYLING, 'visibility');
      }
      display ??= attr(node, NS.TT_STYLING, 'display');
      visibility ??= attr(node, NS.TT_STYLING, 'visibility');
    };
    consider(element);
    consider(regionElement);
    const result = { display: display ?? 'auto', visibility: visibility ?? 'visible' };
    if (!bucket) effectiveMemo.set(element, new Map([[memoKey, result]]));
    else bucket.set(memoKey, result);
    return result;
  }

  if (!body) {
    return {
      ok: true,
      timeBase: presentTimeBase(readTimeBase(document, NS)),
      fragments: [],
      issues: issues.length ? dedupe(issues) : [{ code: 'no-body', path: '/tt', message: '文档缺少 body，没有可采集的文字' }],
    };
  }

  function ttmlChildren(element) {
    return element.children.filter(child => child.type === 'element' && child.ns === NS.TT && CONTENT.has(child.local));
  }

  function resolveOffset(raw, element) {
    if (raw === undefined) return { rational: undefined };
    const parsed = parseExpression(raw, timeBase);
    if (parsed.unresolved) {
      note(parsed.reason, pathOf(element), `时间表达式无法确定：${raw}`, { expression: raw });
      return { unresolved: true };
    }
    return { rational: parsed.rational };
  }

  function makeBasis(element, origin) {
    return {
      path: pathOf(element),
      kind: element.local,
      timeContainer: attr(element, null, 'timeContainer') ?? null,
      begin: attr(element, null, 'begin') ?? null,
      end: attr(element, null, 'end') ?? null,
      dur: attr(element, null, 'dur') ?? null,
      origin: origin === null ? null : toNumber(origin),
    };
  }

  // 遍历一个元素。context: { origin, tainted, container, parentEnd, basisChain }
  // 输出写入 timingMap：{ begin(Rational|null), end(Rational|null), tainted, interval, basisChain }
  function walk(element, context) {
    const rawBegin = attr(element, null, 'begin');
    const rawEnd = attr(element, null, 'end');
    const rawDur = attr(element, null, 'dur');
    const basis = makeBasis(element, context.origin);
    const basisChain = [...context.basisChain, basis];

    // body 根的起点在进入 walk 前已按其 begin 解析为 bodyOrigin，这里不再重复偏移
    const isRootBody = element === body;
    const beginPart = isRootBody ? { rational: undefined } : resolveOffset(rawBegin, element);
    const endPart = resolveOffset(rawEnd, element);
    const durPart = resolveOffset(rawDur, element);
    let tainted = context.tainted || beginPart.unresolved || endPart.unresolved || durPart.unresolved;

    let begin = null;
    if (!tainted) begin = beginPart.rational !== undefined ? add(context.origin, beginPart.rational) : context.origin;

    let end = null;
    let needsSeqEnd = false;
    if (!tainted) {
      if (endPart.rational !== undefined && durPart.rational !== undefined) {
        note('end-and-dur', pathOf(element), '同时声明 end 与 dur，按 TTML 规则 end 优先', { end: rawEnd, dur: rawDur });
      }
      if (endPart.rational !== undefined) {
        // par：end 相对父起点；seq：end 相对顺序容器（父）起点而非前一兄弟结束点
        const endOrigin = context.container === 'seq' ? context.parentBegin : context.origin;
        end = add(endOrigin, endPart.rational);
      }
      else if (durPart.rational !== undefined) end = add(begin, durPart.rational);
      else if (context.container === 'par') end = context.parentEnd; // 可空：开放区间合法
      else needsSeqEnd = true; // seq 的隐式结束等子元素走完后再推断
      if (end !== null && cmp(end, begin) < 0) {
        note('contradictory-interval', pathOf(element), `时间约束矛盾：begin=${rawBegin ?? '继承'} 晚于 end=${rawEnd ?? rawDur}`, { begin: rawBegin ?? null, end: rawEnd ?? null, dur: rawDur ?? null });
        tainted = true;
      }
    }

    const record = { begin: tainted ? null : begin, end: tainted ? null : end, tainted, needsSeqEnd, interval: null, basisChain };

    if (CONTAINERS.has(element.local)) {
      const declared = attr(element, null, 'timeContainer');
      if (declared && declared !== 'par' && declared !== 'seq') {
        note('unknown-time-container', pathOf(element), `未知 timeContainer：${declared}，按 par 处理`, { timeContainer: declared });
      }
      const kind = declared === 'seq' ? 'seq' : 'par';
      basis.timeContainer = kind;
      if (declared && declared !== 'par' && declared !== 'seq') basis.timeContainer = declared;
      timingMap.set(element, record);

      if (kind === 'par') {
        for (const child of ttmlChildren(element)) {
          walk(child, { origin: record.begin, tainted, container: 'par', parentBegin: record.begin, parentEnd: record.end, basisChain });
        }
      } else {
        let cursor = record.begin;
        let cursorTainted = tainted;
        const children = ttmlChildren(element);
        children.forEach((child, index) => {
          walk(child, { origin: cursor, tainted: cursorTainted, container: 'seq', parentBegin: record.begin, parentEnd: record.end, basisChain });
          const childRecord = timingMap.get(child);
          if (!childRecord.tainted && childRecord.end !== null) {
            cursor = childRecord.end;
            cursorTainted = false;
          } else {
            // 末步结束无法确定只影响容器的隐式结束；非末步还会污染后续兄弟
            if (index < children.length - 1) note('seq-end-unresolved', pathOf(child), '顺序容器前一步无法确定结束时刻，后续兄弟的继承时间无法确定');
            cursorTainted = true;
          }
        });
        if (needsSeqEnd && !tainted) {
          const last = children.length ? timingMap.get(children[children.length - 1]) : null;
          if (last && !last.tainted && last.end !== null) end = last.end;
          else { note('seq-end-unresolved', pathOf(element), '顺序容器缺少 end/dur 且无法从末步子元素推断结束时刻'); tainted = true; }
        }
      }
      record.end = tainted ? null : end;
      record.tainted = tainted;
      record.interval = presentInterval(record, rawBegin, rawEnd, rawDur);
      return;
    }

    // 内容元素 p/span
    timingMap.set(element, record);
    record.interval = presentInterval(record, rawBegin, rawEnd, rawDur);
    if (element.local === 'p') {
      const walkSpans = parent => {
        for (const child of ttmlChildren(parent)) {
          if (child.local === 'span') {
            walk(child, { origin: record.begin, tainted: record.tainted, container: 'par', parentBegin: record.begin, parentEnd: record.end, basisChain });
            walkSpans(child);
          }
        }
      };
      walkSpans(element);
      emitFragment(element, record, basisChain);
    }
  }

  function presentInterval(record, rawBegin, rawEnd, rawDur) {
    return record.tainted
      ? { status: 'unresolved', begin: null, end: null, raw: { begin: rawBegin ?? null, end: rawEnd ?? null, dur: rawDur ?? null } }
      : { status: 'resolved', begin: toNumber(record.begin), end: record.end === null ? null : toNumber(record.end), raw: { begin: rawBegin ?? null, end: rawEnd ?? null, dur: rawDur ?? null } };
  }

  function regionOf(element) {
    let current = element;
    while (current && current.type === 'element') {
      const reference = attr(current, null, 'region');
      if (reference !== undefined) return reference;
      current = current.parent;
    }
    return null;
  }

  function emitFragment(pElement, record, basisChain) {
    const regionId = regionOf(pElement);
    const regionElement = regionId ? regions.get(regionId) ?? null : null;
    if (regionId && !regionElement) note('unknown-region', pathOf(pElement), `引用的区域 ${regionId} 不存在`, { region: regionId });
    const properties = effectiveProperties(pElement, regionElement);
    if (properties.display === 'none') {
      note('display-none', pathOf(pElement), '元素 display=none，整棵子树不产生可见文字', { region: regionId });
      return;
    }
    const pieces = collectVisibleText(pElement, regionElement);
    const text = pieces.map(piece => piece.text).join('');
    if (!text.trim()) {
      // 只有样式/结构没有正文的元素不是一条字幕
      note('empty-fragment', pathOf(pElement), '元素没有可见正文，不生成字幕片段', { region: regionId });
      return;
    }
    const spans = collectSpanRecords(pElement, regionElement);
    fragments.push({
      id: attr(pElement, NS.XML, 'id') ?? null,
      region: regionId,
      regionResolved: Boolean(regionElement),
      text,
      searchText: text.replace(/\s+/g, ' ').trim(),
      timing: record.interval,
      basis: basisChain,
      styles: {
        references: (attr(pElement, null, 'style') ?? '').split(/\s+/).filter(Boolean),
        display: properties.display,
        visibility: properties.visibility,
        regionStyle: regionElement ? (attr(regionElement, null, 'style') ?? null) : null,
      },
      spans,
      path: pathOf(pElement),
    });
  }

  // 记录片段内所有 span（含被隐藏的），便于回查样式引用与文字取舍依据。
  function collectSpanRecords(element, regionElement) {
    const records = [];
    const visit = node => {
      for (const child of ttmlChildren(node)) {
        if (child.local === 'span') {
          const properties = effectiveProperties(child, regionElement);
          const timing = timingMap.get(child);
          records.push({
            path: pathOf(child),
            style: attr(child, null, 'style') ?? null,
            display: properties.display,
            visibility: properties.visibility,
            timing: timing ? timing.interval : null,
          });
        }
        visit(child);
      }
    };
    visit(element);
    return records;
  }

  // 递归收集可见文字。可见性按每个元素自身的解析值判断：
  // 父元素 visibility:hidden 时，子元素 visibility:visible 可以重新显示（TTML 继承语义）；
  // display:none 整棵跳过；<br/> 保留为换行。
  function collectVisibleText(element, regionElement) {
    const pieces = [];
    const own = effectiveProperties(element, regionElement);
    const elementVisible = own.visibility !== 'hidden';
    for (const child of element.children) {
      if (child.type === 'text') {
        if (elementVisible) pieces.push({ text: child.text, visible: true, element });
        continue;
      }
      if (child.ns !== NS.TT) continue;
      if (child.local === 'br') { pieces.push({ text: '\n', visible: elementVisible, element: child }); continue; }
      if (!CONTENT.has(child.local)) continue;
      const properties = effectiveProperties(child, regionElement);
      if (properties.display === 'none') {
        note('display-none', pathOf(child), '元素 display=none，整棵子树不产生可见文字');
        continue;
      }
      if (properties.visibility === 'hidden') {
        note('hidden-content', pathOf(child), 'visibility=hidden 的文字不采集，但可见后代仍采集', { style: attr(child, null, 'style') ?? null });
      }
      pieces.push(...collectVisibleText(child, regionElement));
    }
    return pieces;
  }

  // body 起点：默认文档零点；自身 begin 相对零点偏移
  const bodyRawBegin = attr(body, null, 'begin');
  const bodyBeginPart = resolveOffset(bodyRawBegin, body);
  let bodyOrigin = ZERO;
  let bodyTainted = false;
  if (bodyBeginPart.unresolved) bodyTainted = true;
  else if (bodyBeginPart.rational) bodyOrigin = bodyBeginPart.rational;

  const fragments = [];
  walk(body, { origin: bodyOrigin, tainted: bodyTainted, container: 'par', parentBegin: bodyOrigin, parentEnd: null, basisChain: [] });

  return { ok: true, timeBase: presentTimeBase(timeBase), fragments, issues: dedupe(issues) };
}

function dedupe(issues) {
  const seen = new Set();
  const result = [];
  for (const issue of issues) {
    const key = JSON.stringify(issue);
    if (!seen.has(key)) { seen.add(key); result.push(issue); }
  }
  return result;
}

function registerStyle(styleElement, styles, note, externalHref = null) {
  const id = attr(styleElement, NS.XML, 'id');
  if (!id) { note('style-without-id', pathOf(styleElement), 'style 缺少 xml:id，无法被引用', { href: externalHref }); return; }
  if (styles.has(id)) { note('duplicate-style', pathOf(styleElement), `样式 ${id} 重复定义，采用首个定义`, { style: id, href: externalHref }); return; }
  styles.set(id, styleElement);
}

function presentTimeBase(timeBase) {
  return {
    declared: timeBase.declared,
    frameRate: timeBase.frameRate === undefined ? null : Number(timeBase.frameRate),
    frameRateMultiplier: timeBase.frameRateMultiplier === undefined ? null : toNumber(timeBase.frameRateMultiplier),
    effectiveFrameRate: timeBase.effectiveFrameRate === undefined ? null : toNumber(timeBase.effectiveFrameRate),
    tickRate: timeBase.tickRate === undefined ? null : Number(timeBase.tickRate),
  };
}
