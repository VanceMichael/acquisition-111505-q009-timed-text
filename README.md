# 展陈字幕的嵌套计时与分区文字采集

这是面向资料接收人员的 Node.js 服务。提供人工收件、合作方定时文本自动采集、原始字节保管、业务身份版本记录和收件查询；本地来源独立提供合作方交互环境。自动采集按交付声明解释 TTML 子集，只保留真正可见的文字片段及其时间依据，不把两侧屏幕的字幕串成一句。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、TTML 解释、采集流程、HTTP 入口及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口，`SOURCE_URL` 可覆盖采集默认来源。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`。`npm run demo` 使用临时目录和系统分配端口展示采集、冲突保留、外置样式与人工收件，结束即清理。

## 接口与目录

- `POST /api/collect` 触发一次定时文本采集。请求体可选 `{ "source": "http://host:port", "probePath": "/subtitles" }`，缺省来源为本地合作方服务。服务先探查清单，再按清单 href 同源抓取 XML；清单 `styles[].href` 授权的外置样式才会抓取，其余引用一律不访问。
- `GET /api/collections` 查询自动采集的全部解释收据（按文档身份分版本）。
- `GET /api/raw/:sha256` 凭摘要取回原始交付字节，解释结果与原文据此共同回查。
- `POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象；`GET /api/records` 查询全部收件版本（含人工与采集两个来源）；`GET /health` 检查进程。

人工记录身份字段为 document, region, begin；采集记录身份为 document。同一身份与相同原文重复提交复用版本，内容变化保留旧版本，不同来源不能混淆。归档目录有按摘要保存的 blobs 和按业务身份保存的 receipts。

## 解释规则与问题保留

`src/ttml/` 是零依赖的 TTML 子集解释器：自带严格 XML 解析（无 DTD、无外部实体、未知实体拒绝），按文档声明的 `frameRate`、`frameRateMultiplier`、`tickRate` 用有理分数精确换算 `h:m:s`、`s/ms`、`f`、`t` 表达式。嵌套 `par` 容器按父起点偏移、`seq` 容器按前一兄弟结束点衔接；区域沿祖先继承；样式引用链（含区域样式与授权外置样式）决定 `display` 与 `visibility`，`display:none` 整棵跳过，`visibility:hidden` 只隐藏自身文字而可见后代仍采集，`<br/>` 保留为换行。只有样式没有正文的元素不生成片段。

帧率/时基缺失、时间表达式无法确定、`begin` 晚于 `end` 等矛盾、外置样式不可得、未知区域或样式引用，都登记在解释结果的 `issues` 中：时间无法确定时片段保留原始表达式并标记 `unresolved`，绝不套默认帧率制造精确时刻；seq 中前一步无法确定结束时，后续兄弟的继承时刻一并标记为不可确定。

`src/` 为收件、采集与解释，`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`，解释结果结构与问题代码见 `docs/collection.md`。

## 容器

`docker build -t timed-text:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 timed-text:local` 启动。环境准备后，`docker run --rm --network none timed-text:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查全部功能。
