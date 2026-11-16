# 定时文本采集与解释结果约定

本文档规定自动采集（`POST /api/collect`）的内部架构、解释结果结构与问题代码。`docs/source-contract.md` 只划定合作来源的协议边界，不规定本服务内部实现。

## 采集流程

1. 探查来源 `GET /subtitles`，取得交付清单：`[{ id, revision, href, styles?: [{ id?, href }] }]`。
2. 清单条目按实际来源地址解释相对链接；解析后跨源的链接直接拒绝，不发起请求。
3. 只抓取清单内文档 href 与 `styles[].href` 授权的外置样式；文档中出现但清单未授权的样式引用不产生任何外部请求。
4. 原始 XML 字节先按 sha256 写入 blobs，再做解释；即使解释失败或发现矛盾，原文也已落盘可回查。
5. 解释结果作为收据 data 与原始摘要一起按 `source=collector`、`identity={document}` 归档；相同原文重复采集复用版本，修订交付新增版本，旧讲解稿保持不变。

## 解释结果结构

收据 `versions[].data.interpretation`：

- `timeBase`：文档声明的回显。`declared` 保留 `frameRate`、`frameRateMultiplier`、`tickRate` 原始字符串；未声明字段在数值部分为 `null`，不补默认值；另给 `effectiveFrameRate`（帧率 × 倍率）供核对。
- `fragments[]`：真正可见的文字片段，每个对应一个产生正文的 `p`（含其可见 span 文字）。
  - `region`：实际生效区域（沿祖先继承），`regionResolved` 表示区域定义是否存在。
  - `text`：可见文字，`<br/>` 保留为换行；`searchText` 为空白折叠后的检索形态。不同区域、不同片段永不串接。
  - `timing`：`{ status: 'resolved'|'unresolved', begin, end, raw }`。`end` 为 `null` 表示开放区间（合法）；`unresolved` 时 `begin/end` 为 `null`，`raw` 保留 `begin/end/dur` 原始表达式。
  - `basis[]`：从 `body` 到该片段的时间依据链，每一级含路径、容器类型（par/seq）、原始 timing 属性与该级继承起点 `origin`。
  - `styles`：片段引用的样式 id、生效 display/visibility、区域样式；`spans[]` 记录内部所有 span（含被隐藏的）的样式与计时，说明文字取舍依据。
  - `path`：元素在文档中的结构路径，带 xml:id 时一并标出。
- `issues[]`：见下。问题不阻断采集，原文与片段（可能带 unresolved 计时）都保留。

## 计时语义

- 表达式：`h:m:s(.fraction)` 时钟型；`Nms`、`N(.f)s`、`Nf`、`Nt` 偏移型。所有中间结果使用 BigInt 有理分数，输出时四舍五入到 9 位小数。
- `par`（body 缺省即 par）：子元素 begin/end 相对父区间起点；无 end/dur 时隐式结束取父区间结束，父区间开放则片段开放。
- `seq`：子元素 begin 相对前一兄弟的结束点；end 相对顺序容器自身起点；无 end/dur 时隐式结束取末步子元素结束。前一步结束无法确定时，后续兄弟的继承时刻标记 unresolved。
- end 与 dur 同时存在：登记 `end-and-dur`，按 TTML 规则 end 优先。
- 解析后 end 早于 begin：登记 `contradictory-interval`，该片段时刻 unresolved；seq 下游一并污染。
- 帧表达式缺 frameRate（或时基声明非法）：登记 `frame-expression-without-frame-rate` 等，不假设 24/25/30 等默认帧率；tick 与时钟表达式不受影响，仍可确定。

## 问题代码

| code | 含义 |
| --- | --- |
| `malformed-xml` / `not-ttml` | XML 无法解析或根元素不是 TTML |
| `invalid-timebase` | frameRate / multiplier / tickRate 声明非法 |
| `unparseable-time-expression` | 表达式语法或单位不支持 |
| `frame-expression-without-frame-rate` / `tick-expression-without-tick-rate` | 表达式需要的时基未声明 |
| `contradictory-interval` | begin 晚于 end 等互相矛盾的约束 |
| `seq-end-unresolved` | seq 隐式结束或前序衔接时刻无法确定 |
| `end-and-dur` | end 与 dur 同时声明（end 优先） |
| `implicit-end-unresolved` / `unknown-time-container` | 容器结束无法推断或 timeContainer 值未知 |
| `external-style-unavailable` | 清单授权的外置样式取不到或无法解析 |
| `unknown-style` / `style-cycle` / `style-without-id` / `duplicate-style` | 样式引用问题 |
| `unknown-region` / `region-without-id` / `duplicate-region` | 区域引用问题 |
| `display-none` / `hidden-content` / `empty-fragment` | 可见性取舍记录；empty-fragment 表示只有样式没有正文，不生成字幕 |
| `document-unavailable` / `invalid-style-entry` / `interpreter-failure` | 采集阶段的抓取与防护问题 |

## 来源情景（仅本地 provider）

`POST /__control` 可切换 `mode`：`intro`（标准交付）、`conflict`（含 begin 晚于 end 的矛盾原文）、`external`（授权外置样式可取得）、`missingStyle`（授权 href 返回 404）。切换只影响后续来源响应，不改写已归档收据。
