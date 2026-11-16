# 合作来源约定

## 资料边界

/subtitles 返回交付清单及 XML href。清单条目形如 `{ id, revision, href, styles? }`，`styles` 为可选的授权外置样式数组（每项含 href）；收件端只抓取清单内 href 与授权样式 href，解析后跨源的链接拒绝访问。支持 TTML 子集：tt/head/styling/layout/body/div/p/span/br，xml:id、region、style、begin、end、dur、timeContainer=par|seq；根参数 frameRate、frameRateMultiplier、tickRate。表达式支持 h:m:s、秒 s、帧 f、tick t。样式含 display 和 visibility，并按引用/继承生效。无外部实体解析；外置样式仅清单授权 href 可取，取不到时收件端保留问题而不臆造可见性。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/subtitles`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。
