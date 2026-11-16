// 交付声明 TTML 子集所需的最小严格 XML 解析器。
// 安全边界：不支持 DTD，因此不存在外部实体注入面；未知实体一律拒绝。
// 命名空间按 URI 识别，前缀可以与样例不同（如 ttp:/tts: 被改名仍可识别）。

export const XML_NS = 'http://www.w3.org/XML/1998/namespace';
// xml 前缀按 XML 规范固定绑定，不依赖文档是否声明 xmlns:xml
const PREFIX_BINDINGS = new Map([['xml', XML_NS]]);

export class XmlError extends Error {
  constructor(message, position) {
    super(position === undefined ? message : `${message}（位置 ${position}）`);
    this.name = 'XmlError';
  }
}

const isNameStart = char => /[A-Za-z_:]/.test(char);
const isNameChar = char => /[\w:.\-]/.test(char);
const isWhitespace = char => char === ' ' || char === '\t' || char === '\r' || char === '\n';

function decodeEntities(raw, fail) {
  let output = '';
  let cursor = 0;
  while (cursor < raw.length) {
    const amp = raw.indexOf('&', cursor);
    if (amp === -1) { output += raw.slice(cursor); break; }
    output += raw.slice(cursor, amp);
    const semi = raw.indexOf(';', amp + 1);
    if (semi === -1 || semi - amp > 32) throw fail('实体缺少结束分号');
    const token = raw.slice(amp + 1, semi);
    if (token === 'amp') output += '&';
    else if (token === 'lt') output += '<';
    else if (token === 'gt') output += '>';
    else if (token === 'quot') output += '"';
    else if (token === 'apos') output += "'";
    else if (/^#\d+$/.test(token)) {
      const code = Number(token.slice(1));
      if (code > 0x10ffff || code === 0) throw fail('不合法的数字字符引用');
      output += String.fromCodePoint(code);
    } else if (/^#x[0-9a-fA-F]+$/.test(token)) {
      const code = parseInt(token.slice(2), 16);
      if (code > 0x10ffff || code === 0) throw fail('不合法的十六进制字符引用');
      output += String.fromCodePoint(code);
    } else if (/^#/.test(token)) throw fail('不合法的数字字符引用');
    else throw fail(`未知实体 &${token};（本服务不解析 DTD 实体）`);
    cursor = semi + 1;
  }
  return output;
}

function splitQName(qname) {
  const index = qname.indexOf(':');
  return index === -1 ? { prefix: '', local: qname } : { prefix: qname.slice(0, index), local: qname.slice(index + 1) };
}

export function parseXml(input) {
  const source = typeof input === 'string' ? input : Buffer.from(input).toString('utf8');
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (message, at = index) => { throw new XmlError(message, at); };

  const readName = () => {
    if (!isNameStart(source[index])) fail('标记名称不合法');
    let end = index;
    while (end < source.length && isNameChar(source[end])) end += 1;
    const name = source.slice(index, end);
    index = end;
    // 名称后只能是空白、属性结束或自闭合；等号说明属性缺少名称
    if (source[index] === '=') fail('属性缺少名称');
    return name;
  };

  let root = null;
  const stack = [];
  let sawTextAfterRoot = false;

  const attach = node => {
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (node.type === 'element') {
      if (root) fail('文档只能有一个根元素');
      root = node;
    }
  };

  while (index < source.length) {
    if (source.startsWith('<?', index)) {
      const close = source.indexOf('?>', index + 2);
      if (close === -1) fail('处理指令缺少结束');
      index = close + 2;
      continue;
    }
    if (source.startsWith('<!--', index)) {
      const close = source.indexOf('-->', index + 4);
      if (close === -1) fail('注释缺少结束');
      if (source.slice(index + 4, close).includes('--')) fail('注释内不能出现 --');
      index = close + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', index)) {
      const close = source.indexOf(']]>', index + 9);
      if (close === -1) fail('CDATA 缺少结束');
      const text = { type: 'text', text: source.slice(index + 9, close), parent: stack[stack.length - 1] ?? null };
      attach(text);
      index = close + 3;
      continue;
    }
    if (source.startsWith('<!', index)) fail('不支持 DTD 或非 CDATA 声明，外部实体不会被解析');
    if (source[index] !== '<') {
      const next = source.indexOf('<', index);
      const end = next === -1 ? source.length : next;
      const raw = source.slice(index, end);
      const text = decodeEntities(raw, fail);
      if (text.length) {
        const node = { type: 'text', text, parent: stack[stack.length - 1] ?? null };
        attach(node);
        if (root && stack.length === 0 && text.trim()) sawTextAfterRoot = true;
      }
      index = end;
      continue;
    }
    if (source.startsWith('</', index)) {
      index += 2;
      const qname = readName();
      while (index < source.length && isWhitespace(source[index])) index += 1;
      if (source[index] !== '>') fail('结束标记格式不合法');
      index += 1;
      const open = stack.pop();
      if (!open || open.qname !== qname) fail(`结束标记 ${qname} 与开始标记不匹配`);
      if (stack.length === 0) sawTextAfterRoot = false;
      continue;
    }

    index += 1;
    const qname = readName();
    while (index < source.length && isWhitespace(source[index])) index += 1;
    let scan = index;
    // 先扫一遍属性以建立本元素命名空间作用域，再解析属性命名空间
    const attrsRaw = [];
    while (scan < source.length && !source.startsWith('>', scan) && !source.startsWith('/>', scan)) {
      while (scan < source.length && isWhitespace(source[scan])) scan += 1;
      if (source.startsWith('>', scan) || source.startsWith('/>', scan)) break;
      let nameEnd = scan;
      while (nameEnd < source.length && isNameChar(source[nameEnd])) nameEnd += 1;
      if (nameEnd === scan) fail('属性缺少名称');
      const attrName = source.slice(scan, nameEnd);
      scan = nameEnd;
      while (scan < source.length && isWhitespace(source[scan])) scan += 1;
      if (source[scan] !== '=') fail('属性缺少等号');
      scan += 1;
      const quote = source[scan];
      if (quote !== '"' && quote !== "'") fail('属性值必须加引号');
      scan += 1;
      const valueClose = source.indexOf(quote, scan);
      if (valueClose === -1) fail('属性值缺少结束引号');
      attrsRaw.push([attrName, decodeEntities(source.slice(scan, valueClose), fail)]);
      scan = valueClose + 1;
    }
    const nsMap = new Map(stack.length ? stack[stack.length - 1].nsMap : []);
    for (const [attrName, value] of attrsRaw) {
      if (attrName === 'xmlns') nsMap.set('', value);
      else if (attrName.startsWith('xmlns:')) nsMap.set(attrName.slice(6), value);
    }
    const attributes = [];
    for (const [attrName, value] of attrsRaw) {
      const isXmlns = attrName === 'xmlns' || attrName.startsWith('xmlns:');
      const parts = isXmlns
        ? { prefix: attrName === 'xmlns' ? '' : 'xmlns', local: attrName === 'xmlns' ? 'xmlns' : attrName.slice(6) }
        : splitQName(attrName);
      attributes.push({
        qname: attrName,
        prefix: parts.prefix,
        local: parts.local,
        ns: parts.prefix && !isXmlns ? (nsMap.get(parts.prefix) ?? PREFIX_BINDINGS.get(parts.prefix) ?? null) : null,
        value,
      });
    }
    index = scan;
    const selfClosing = source.startsWith('/>', index);
    if (!selfClosing && source[index] !== '>') fail('元素标记缺少结束');
    index += selfClosing ? 2 : 1;
    const parts = splitQName(qname);
    const element = {
      type: 'element',
      qname,
      prefix: parts.prefix,
      local: parts.local,
      ns: parts.prefix ? (nsMap.get(parts.prefix) ?? PREFIX_BINDINGS.get(parts.prefix) ?? null) : (nsMap.get('') ?? null),
      attrs: attributes,
      nsMap,
      children: [],
      parent: stack[stack.length - 1] ?? null,
    };
    attach(element);
    if (!selfClosing) stack.push(element);
  }
  if (stack.length) fail(`元素 ${stack[stack.length - 1].qname} 缺少结束标记`);
  if (!root) fail('文档没有根元素');
  if (sawTextAfterRoot) fail('根元素之后不允许出现文本');
  return root;
}

export function attr(element, ns, local) {
  const found = element.attrs.find(attribute => attribute.local === local && (ns === null || attribute.ns === ns));
  return found ? found.value : undefined;
}

export function childElements(element, local, ns) {
  return element.children.filter(child => child.type === 'element' && child.local === local && (ns === undefined || child.ns === ns));
}

export function findFirst(element, local, ns) {
  return childElements(element, local, ns)[0] ?? null;
}
