import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, attr, XML_NS } from '../src/ttml/xml.mjs';

test('解析命名空间、属性与文本结构', () => {
  const root = parseXml('<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"><body tts:visibility="visible"><p xml:id="p1">文字<br/>换行</p></body></tt>');
  assert.equal(root.ns, 'http://www.w3.org/ns/ttml');
  const p = root.children[0].children[0];
  assert.equal(p.local, 'p');
  assert.equal(attr(p, XML_NS, 'id'), 'p1');
  const body = root.children[0];
  assert.equal(attr(body, 'http://www.w3.org/ns/ttml#styling', 'visibility'), 'visible');
  assert.equal(p.children.map(node => node.type).join(','), 'text,element,text');
  assert.equal(p.children[1].local, 'br');
});

test('xml 前缀按规范固定绑定，不依赖文档声明', () => {
  const root = parseXml('<tt xmlns="http://www.w3.org/ns/ttml"><region xml:id="r1"/></tt>');
  assert.equal(attr(root.children[0], XML_NS, 'id'), 'r1');
});

test('实体只接受内置与字符引用，拒绝未知实体', () => {
  const root = parseXml('<tt xmlns="x"><p>a&amp;b&lt;c&#65;&#x42;</p></tt>');
  assert.equal(root.children[0].children[0].text, 'a&b<cAB');
  assert.throws(() => parseXml('<tt xmlns="x"><p>&custom;</p></tt>'), /未知实体/);
});

test('拒绝 DTD 与外部实体声明', () => {
  assert.throws(() => parseXml('<!DOCTYPE tt [<!ENTITY x SYSTEM "file:///etc/passwd">]><tt xmlns="x"/>'), /不支持 DTD/);
});

test('标记不闭合、根元素重复时给出格式错误', () => {
  assert.throws(() => parseXml('<tt xmlns="x"><p>文字</tt>'), /不匹配/);
  assert.throws(() => parseXml('<a xmlns="x"/><b xmlns="x"/>'), /只能有一个根元素/);
  assert.throws(() => parseXml('<tt xmlns="x"><p attr="1">'), /缺少结束/);
  assert.throws(() => parseXml('<a ="1"/>'), /属性缺少名称/);
});

test('xmlns 声明与前缀属性的命名空间分别正确归属', () => {
  const root = parseXml('<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:frameRate="30"/>');
  const frameRate = root.attrs.find(item => item.qname === 'ttp:frameRate');
  assert.equal(frameRate.local, 'frameRate');
  assert.equal(frameRate.ns, 'http://www.w3.org/ns/ttml#parameter');
  const xmlns = root.attrs.find(item => item.qname === 'xmlns:ttp');
  assert.equal(xmlns.local, 'ttp');
  assert.equal(xmlns.ns, null);
});

test('注释、CDATA 与处理指令不参与文字内容', () => {
  const root = parseXml('<?xml version="1.0"?><!-- 说明 --><tt xmlns="x"><p><![CDATA[a < b & c]]></p></tt>');
  assert.equal(root.children[0].children[0].text, 'a < b & c');
});
