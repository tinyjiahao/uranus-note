# Uranus v1 — Cloudflare 原生开源笔记应用需求规格

> 日期：2026-10-24。状态：用于从零实现的统一需求基线，不代表当前代码已全部完成。
> 技术架构：React + Vite SPA、Hono API、Cloudflare Workers、D1 和私有 R2。
> 本文是产品、工程与验收的完整需求基线。AGENTS.md、README、实现代码和部署说明应与本文保持一致。
> 后续增量需求见 `plan_v2.md`：编辑宽度、表格、排序与设置。本文保留 v1 范围；v2 中明确调整的要求用于对应增量，待确认鉴权方案不自动替代本版安全约束。

## 1. 产品目标与范围

Uranus 是单用户、开源、自部署的 Web 备忘录，体验对齐 macOS 备忘录：三栏布局、富文本编辑、自动保存、搜索、版本历史和回收站。部署者拥有自己的 Worker、D1 和 R2，服务不依赖维护者的中央账号、数据代理或遥测。

- 前端是桌面优先的 React SPA；同一域名提供静态应用和 `/api/*`。
- 后端是 Hono Worker；全部结构化业务数据写入 D1，图片等二进制内容写入私有 R2。
- 一个部署实例代表一个私人笔记空间；持有同一访问令牌的设备具有相同权限。
- 单用户不代表单设备：必须处理多个标签页、设备同时编辑的冲突。
- 官方实例可使用 `https://note.searchdiff.com`；任何部署者可使用自己的域名或 `workers.dev`。
- 用户完成首次登录后，在会话有效期内无需重复填写令牌。

### 1.1 v1 必须交付

三栏与折叠视图、文件夹、笔记增删改查、排序、置顶、星标、回收站；TipTap 富文本、基础表格、图片、外部链接、斜杠命令、Markdown 快捷输入与导入、笔记内查找、只读模式；自动保存与冲突处理、IndexedDB 草稿、版本历史、标题及正文子串搜索、深浅主题；应用令牌登录、安全会话；D1/R2 bindings、本地模拟、迁移、维护任务、可执行的运维备份恢复工具和开源自部署文档。

### 1.2 P2：保留规划，不阻塞 v1

- details/summary 折叠块、`[[` 笔记互链、查找替换和原始 JSON 查看面板。
- 表格列宽拖拽及持久化、Excel/Numbers/网页复杂表格粘贴；v1 仅保证基础表格编辑。
- 分词、相关性排序等高级搜索；v1 不使用 FTS 虚表，也不混合多种检索结果。
- 可视化备份恢复中心；v1 先提供运维工具，不提供网页一键覆盖恢复。
- PDF 附件卡与预览；图片说明文字。
- 标签栏与标签过滤；使用独立标签表，不将正文 `#tag` 当作标签。
- 字数状态栏、打字机模式和当前段落高亮。
- 单篇 Markdown/HTML 导出，表格转 GFM、图片可内联。
- 表格合并单元格、脚注、上/下标、字体颜色（8 色及默认）。
- 单篇密码锁定：需另行设计密码派生、加密、恢复、版本和附件保护，实施前不能宣称端到端加密；密文正文不得派生明文搜索数据。
- PWA 安装入口；不因此引入离线同步。
- CLI Bearer Token 访问，沿用统一 API 权限。

### 1.3 非目标

多租户、用户注册、协作编辑、公开分享、复杂权限；SEO、服务端页面渲染和静态页面预生成；嵌套文件夹；版本 diff；完整离线编辑同步；音视频和任意文件托管。

## 2. 技术方案与职责

| 层 | 选型 | 职责 |
| --- | --- | --- |
| 前端 | React + TypeScript strict + Vite | 浏览器应用与构建 |
| 客户端路由 | React Router Declarative Mode | `/login`、`/`、`/notes/:id`；不使用全栈 loader/action |
| 服务端状态 | TanStack Query | 缓存、分页、mutation、精准失效与重试 |
| UI 状态 | Zustand | 面板、主题、临时交互状态；不复制整份服务端数据 |
| 编辑器 | TipTap / ProseMirror | 富文本 JSON、插件和交互 |
| 样式 | Tailwind CSS + Lucide | 主题与图标 |
| HTTP 后端 | Hono | 路由、鉴权、参数校验和响应 |
| API 契约 | 共享 TypeScript DTO + Zod Schema | 客户端类型、服务端运行时校验；类型声明不替代校验 |
| 数据 | D1 binding `DB` | SQL、普通搜索表、原子批处理 |
| 附件 | R2 binding `UPLOADS` | 私有对象流式存取 |
| 开发与部署 | Cloudflare Vite Plugin + Wrangler | Workers Runtime、本地 bindings、静态资源与 Worker 一次部署 |
| 测试 | Vitest + Workers 测试集成 + Playwright | 纯逻辑、真实本地 bindings、浏览器验收 |

实现时选择相互兼容的稳定版并提交 lockfile，固定 Node 开发版本及 compatibility date；升级后执行回归。Hono 仅承担 HTTP 层，service/repository 不依赖 Hono Context。`nodejs_compat` 只在已验证的依赖确实需要时启用。

```text
浏览器：React / TipTap / TanStack Query
    ├── 页面与 JS/CSS → Workers Static Assets
    └── /api/* → Hono：配置检查、鉴权、CSRF、校验
                         └── service / repository
                               ├── env.DB → D1
                               └── env.UPLOADS → 私有 R2
Cron Trigger → scheduled handler → 同一维护 service
```

### 2.1 路由与资源边界

- 静态 SPA shell 可以公开下载，但不能包含笔记、Secrets 或服务端环境值；未登录时 UI 跳转 `/login`。
- 配置 `/api/*` 优先进入 Worker，不能被 SPA fallback 吞掉；未知 API 必须返回 JSON `404`。
- 客户端深链接刷新返回 SPA；Hono 只处理 API 和必要的维护入口。
- 浏览器只调用同源 API，不直接连接 D1/R2，不默认开放跨域。
- Worker 按请求检查配置，不依赖进程启动钩子、长驻全局连接或内存中唯一状态。
- D1/R2 binding 从 `c.env` 或 scheduled handler 的 `env` 获取，再显式传入业务函数。
- 业务数据、写入队列和维护进度不能只存 Worker 内存。
- 请求取消只能停止客户端等待，不能假定服务器写入也被取消。

## 3. 界面与笔记管理

### 3.1 布局

- 左侧：智能文件夹“全部笔记 / 已加星标 / 最近删除”和用户文件夹分组。
- 中间：全局搜索、排序菜单、笔记标题/摘要/时间列表。
- 右侧：元信息、保存状态、格式工具栏、编辑器和辅助面板。
- 三栏为默认；双栏收起侧栏；单栏为专注视图，正文限定最大行宽。
- 所有折叠状态必须有可见恢复入口，动画不超过 200ms；搜索时自动展开列表。
- 宽度小于 768px 自动使用双栏并提供切换入口，更窄时保证单栏操作可达。
- 文件夹分组只能整体折叠，无嵌套子文件夹；新建文件夹后自动展开。
- 视图、分组折叠、排序、主题和每篇只读偏好存 localStorage，以 `uranus.` 命名空间管理。

### 3.2 笔记与文件夹

- 初始化迁移创建系统默认“Notes”文件夹，以系统标记识别；不可删除，不能靠可修改的名称判断默认文件夹。
- 新建笔记落入当前普通文件夹；从智能文件夹新建则落入默认文件夹，立即进入编辑态。
- 标题从首个文本行派生，摘要取首个非空文本段；空标题显示“未命名笔记”。
- 文件夹支持新建、重命名、删除。删除文件夹将其中笔记软删除，保存 `prev_folder_id`，将有效 `folder_id` 移至默认文件夹后删除文件夹，避免外键悬空。
- 普通删除将 `deleted_at` 设为服务端时间并记原文件夹；软删除保留内容、版本和附件。
- 恢复优先回原文件夹；原文件夹已删除则回默认文件夹。
- 支持硬删除、一键清空回收站；硬删除需确认，并按第 9 节分阶段执行。
- 回收站中笔记可查看，不可编辑内容或恢复版本；先恢复笔记再执行这些操作。
- 回收站超过 30 天的记录通过每日 Cron 分批清理，无需等待用户访问。
- 支持菜单移动笔记；拖拽移动可选。置顶只影响当前列表排序，星标形成跨文件夹智能列表。

### 3.3 排序与列表

- 排序字段：修改时间（默认）、创建时间、标题；方向升序或降序。
- 置顶始终在前，标题空值在后；同值以 id 作稳定排序。
- 中文标题按 SQLite 字符序比较，不引入拼音排序。
- 排序字段和方向必须从服务端白名单映射，禁止直接拼接用户输入。
- 保存后排序变化允许笔记移动位置，但选中状态不得丢失。
- 回收站沿用排序规则。列表与搜索默认 50 条，最多 100 条，响应附分页信息。
- 列表不返回正文 JSON/HTML，长列表采用增量加载或虚拟化。
- v1 使用页码分页；筛选、排序或数据变化影响列表顺序时重置分页缓存并重新加载，按 id 去重，保留选中笔记。不承诺并发变化期间的跨页快照一致性。

## 4. 编辑器

### 4.1 内容与格式

- TipTap JSON 是唯一权威正文；客户端提交 JSON，服务端校验节点/属性并派生标题、摘要和搜索纯文本。
- HTML 用于渲染或导出时按需生成和清洗，不作为同一 D1 行中的持久化副本。
- 支持 H1/H2/H3、段落、无序/有序列表、待办、引用、代码块、行内代码、分隔线、基础表格、图片。
- 行内支持加粗、斜体、下划线、删除线、黄色高亮和链接。
- 节点 schema、JSON 深度和节点数量要有限制，恶意复杂结构不能耗尽 Worker CPU 或卡死编辑器。
- 笔记、快照和提交 DTO 带 `content_schema_version`，初始为 1。升级提供可测试的内容迁移；不支持的版本/节点返回 400 `UNSUPPORTED_CONTENT_SCHEMA`，保留草稿并提示升级，禁止静默丢弃节点。旧客户端不得覆盖无法解析的新正文。

### 4.2 表格

- 工具栏、`⌘⌥T` 或 `/table` 插入默认 2×2 带表头表格。
- 悬浮工具条提供行列增删和表头开关；Tab 切换单元格，最后单元格 Tab 新增行。
- 单元格支持文本和行内格式，不支持嵌套复杂块。
- v1 表格使用自适应列宽；外部复杂表格粘贴按白名单转为基础表格或纯文本，降级须提示，不承诺保留合并单元格和列宽。
- 只读模式禁止结构操作；精确表格粘贴和列宽调整在 P2 实施。

### 4.3 外部链接

- `⌘K` 提供显示文本和 URL；无选区时插入显示文本。
- 输入/粘贴 URL 自动识别。悬浮卡可打开、复制、编辑、移除链接。
- 外部链接仅允许 http/https/mailto，使用 `noopener noreferrer`。
- 笔记互链在 P2 实施；v1 不接受自定义协议，粘贴或导入不支持的链接时保留显示文本并提示。

### 4.4 输入效率与查找

- 空块输入 `/` 弹模糊匹配命令菜单：table、todo、code、hr、h1/h2/h3 等；方向键选择、Enter 确认、Esc 关闭。
- Markdown 输入规则包含标题、列表、待办、引用、代码块、分隔线，以及加粗、斜体、删除线、行内代码、高亮。
- `⌘F` 在当前笔记查找，高亮全部匹配，Enter/Shift+Enter 切换并显示计数。
- 查找高亮使用装饰插件，不写入正文，超过 5 万字分块扫描；只读模式也可使用。逐个/全部替换及其快捷键在 P2 实施。

### 4.5 图片、粘贴与 Markdown 导入

- 图片通过粘贴、拖拽、工具栏上传；上传成功后插入附件 id/同源 API 地址，不在正文嵌入 Base64 图片。
- 支持图片拖拽排序和右下角缩放，宽度写入 `attrs.width`。
- 缩放正确处理 pointerup、pointercancel、窗口失焦、窗口外松开和切换笔记，不留拖拽状态。
- v1 允许 PNG/JPEG/WebP/GIF；不接受 SVG、HTML 或宽泛的 `image/*`。PDF 在 P2 开启后才进入白名单。
- 粘贴网页/Word 保留白名单格式，去除 script、事件属性和危险 URL。
- 外部图片默认不自动加载；提供占位和手动上传入口，避免泄露访问行为；v1 不提供任意 URL 服务端抓取。
- 跨笔记粘贴本实例图片时，先通过复制接口生成归属于目标笔记的新附件，再改写待插入 JSON；同笔记可复用原附件。复制期间显示占位，失败显示重试/移除入口，不提交原笔记的附件 id 或声称粘贴成功。复制与上传遵守相同幂等、大小和引用规则。
- `⇧⌘V` 粘贴纯文本；拖入 `.md` 经导入 API 转为合法 TipTap JSON，限制输入/转换后大小，外部图片遵守同一策略。

### 4.6 只读

- `⌘⌥P` 或工具栏切换只读，显示状态条，新笔记默认可编辑。
- 只读时禁止输入、格式、待办勾选、图片缩放、表格修改、链接编辑/移除和版本恢复；保留复制、查找、链接打开及版本预览。
- 置顶、星标、移动、删除属于笔记管理，仍可使用；不会因为只读 NodeView 误操作产生正文保存。
- 只读按笔记记忆，硬删除清理偏好；与布局专注视图独立。
- 此模式是客户端防误触偏好，不是服务端权限或安全边界；持有会话的用户仍拥有完整管理权限。原始 JSON 调试面板放入 P2。

## 5. 自动保存、冲突与恢复

### 5.1 保存流程

- 无保存按钮，停止输入约 800ms 自动保存；编辑器失焦、切换笔记/文件夹和页面隐藏时尝试立即 flush。
- 同一笔记的客户端正文和元数据修改共用串行队列，合并等待中的正文中间状态；请求附 `expected_revision` 和 `operation_id`。置顶、移动、删除等不得绕过队列抢先使用旧 revision；跨标签页仍由服务端乐观锁保护。
- 每次本地编辑递增 `edit_sequence`；发出保存时固定正文、序号及请求负载。成功响应仅确认该序号并推进基准 revision，不覆盖新编辑；仅当前序号已获确认且无待提交修改时显示“已保存”。
- 每次实际写入增加整数 revision，所有修改路径（正文、元数据、软删除、恢复）共用该机制；不使用毫秒时间戳作唯一并发锁。
- SQL 使用 `WHERE id = ? AND revision = ?`，更新行数为零返回 `409` 和最新版本信息。
- 笔记、搜索表、版本快照、附件引用和幂等结果需原子一致。D1 batch 内各衍生写入必须受同一成功条件保护；条件更新返回零不会自动使 batch 回滚，不能继续无条件写搜索表/版本。
- `operation_id` 重试返回同一结果；相同 id、不同请求内容返回冲突。保存串行化只能解决同标签页顺序，服务器仍需处理跨设备并发。

### 5.2 大小与页面退出

- `content_json` 按序列化 UTF-8 字节限制为 **1,500,000 字节**，超限返回 `413`；不是字符数或 1.5MiB。
- 标题、摘要、搜索纯文本和每个 D1 行另设预算并在服务端检查，不能仅验证正文大小；详见第 8 节。
- keepalive/beacon 的约 64KiB 限额是共享在途预算，不能保证每次 64KiB 请求成功；只对完整请求体小于 60KiB 且没有冲突在途保存的场景做最佳努力提交。
- 优先使用带 CSRF Header 的 `fetch(..., { keepalive: true })`；beacon 备用接口使用 JSON body 携带会话绑定 CSRF token、revision、operation_id，并执行相同 Origin 和鉴权校验。
- 超预算跳过退出提交；有未保存内容才注册 beforeunload 提示。浏览器强制关闭不保证送达，不承诺任何情况下零丢失。

### 5.3 失败与本地草稿

- UI 显示正在保存、已保存、保存失败及可操作原因。
- 本地暂存使用 IndexedDB，只用于未提交草稿；键包含实例、本机标签页标识和笔记 id，值包含基准 revision、content_schema_version、edit_sequence、时间及 JSON，不承担离线同步。localStorage 仅放非敏感 UI 偏好。
- 草稿异步防抖写入（目标 300ms），序列化和写入不得阻塞每次按键；预算默认 50MB，提醒清理超过 7 天的草稿，不静默淘汰未确认草稿。捕获配额、禁用、存储被清理等异常，必须提示风险；尚未落盘或浏览器清理的数据无法保证恢复。
- 刷新后登录成功再提供草稿恢复；基准版本已改变时让用户选择加载服务器版或复制本地草稿，不自动覆盖。
- 正常保存确认后，在 IndexedDB 同一事务中仅删除序号与该请求一致的草稿；较新草稿保留并更新其基准 revision，较旧异步写入不得覆盖它。主动退出前提示未保存内容，确认放弃或保存完成后清除 Query Cache、草稿和敏感内存；会话过期时可保留本机草稿待重新登录，界面不得展示正文。本机草稿不是加密保险箱，共用设备需明确提示。
- 401 停止保存并登录；409/413/415 停止自动重试；429/503 遵循 Retry-After；临时网络故障指数退避并抖动，最多 4 次。
- 新建、保存、导入和附件上传采用幂等操作，断网重试不能创建重复笔记或重复版本。

## 6. 搜索与版本历史

### 6.1 搜索

- `⌘⇧F` 聚焦全局搜索；300ms 防抖，取消旧结果展示，输入不阻塞编辑器。
- v1 统一为标题及正文的字面子串匹配，覆盖中文和短词；不使用 FTS 虚表、分词、相关性排序或多路结果合并。
- 派生文本单独放普通表 `uranus_note_search`，以 note_id 为主键，与笔记写入原子同步。搜索字段与查询统一执行 Unicode NFKC 和非 locale 特定小写转换；查询去首尾空白、保留内部空白，按完整查询串匹配任一字段，不拆词。搜索词上限 100 个 Unicode 码点，规范化后再次检查。
- 参数化 `instr()` 查询，不将 `%`、`_`、引号等解释为通配符或 SQL；空白查询回到普通列表。结果沿用第 3.3 节排序和分页，先筛选再匹配。
- 子串检索可能扫描候选数据，先按回收站/文件夹/星标范围筛选并限制返回；必须基准测试，不承诺普通 B-tree 可优化任意包含搜索。
- 默认搜索正常笔记，回收站内仅搜索已删除笔记；返回标题、摘要和匹配片段，不返回整篇正文。
- 高亮按文本安全渲染；规范化文本与原文索引可能不同，必须建立位置映射，不能将规范化偏移直接套用原文。无法可靠映射时返回不带高亮的片段，不改写正文。
- 不引入外部搜索服务，搜索表可从权威 JSON 重建；重建采用维护任务并遵守 revision，不能覆盖同时更新的数据。容量与延迟按第 16 节实测，不承诺免费套餐下无限扫描。

### 6.2 版本

- 只有正文 JSON 实际变化才参与自动快照；元数据修改不生成版本。
- 首次有效内容保存生成 v1；以后距上次快照超过 5 分钟且正文不同才生成。
- 手动标记立即快照；与最新快照相同则跳过。每篇最多 30 份，同一事务裁剪最旧快照及引用关系。
- 快照存 JSON、content_schema_version、标题、字数、时间、来源 revision，不持久化 HTML。
- 版本列表分页且不携带 JSON；预览使用独立只读 TipTap 实例。
- 恢复前确认并备份当前内容，再写入选定版本并更新 revision/搜索表；与当前相同可作为无修改操作返回。旧内容先按明确迁移规则转换，不支持的版本拒绝恢复。不得由前端再次提交恢复内容造成重复保存。
- 恢复保留文件夹、星标、置顶；只读及回收站内禁止恢复。
- 快照引用的附件必须保留直至该快照被裁剪；不能因当前正文移除图片而破坏历史预览。
- 存储随快照增长，部署文档解释容量成本；30 份大正文只是数量上限，不表示免费额度足够。

## 7. 主题、交互与快捷键

- 默认跟随系统，可选浅色/深色/系统；在 React 首次绘制前应用主题，使用满足 CSP 的自托管初始化脚本或固定 hash 脚本。
- 深色使用分层深灰，正文及次要文字对比度至少 4.5:1；占位文字也应满足可读性要求。统一滚动条、选区、代码块、表格边框、高亮与浮层配色。
- code 块整块背景，行内 code 样式不能误伤 pre code；键盘焦点可见，按钮有可访问名称，弹窗有焦点管理。
- `public/icon.svg` 和 180×180 apple-icon 在 index.html 引用；便签/铅笔/行星环概念，暖黄 `#f5c842`，16×16 和两种主题均可辨认。

| 快捷键（macOS） | 行为 |
| --- | --- |
| ⌘N | 新建笔记，浏览器占用时使用按钮 |
| ⌘B / ⌘I / ⌘U | 加粗 / 斜体 / 下划线 |
| ⇧⌘9 / ⌘E / ⇧⌘H | 待办 / 行内代码 / 高亮 |
| ⌘K / ⌘⌥T | 链接 / 表格 |
| ⌘F / ⌘⇧F | 笔记查找 / 全局搜索 |
| ⌘⌥P / ⌘⌥1、2、3 | 只读 / 三、双、单栏 |
| ⇧⌘V | 纯文本粘贴 |
| `/` | 命令菜单 |

Windows/Linux 使用对应 Ctrl/Alt 组合并测试冲突；所有功能提供鼠标入口，不保证拦截浏览器保留快捷键。

## 8. D1 数据模型与事务

### 8.1 命名与隔离

- 项目所有表、虚表、索引、触发器及新增视图均以 `uranus_` 开头；SQLite/Cloudflare 自动维护的内部对象除外。
- 一个共享 D1 中最多部署一个使用本前缀的 Uranus 数据空间；此前缀隔离其他应用，不隔离多个 Uranus 实例。
- binding 对整个 D1 有访问能力，前缀只是命名/操作约束，不是数据库权限隔离。
- 初始化、迁移、回滚、清理和恢复只能操作本项目对象，禁止删除共享数据库或修改其他应用的表。
- 使用 Wrangler migration history `uranus_d1_migrations` 管理本项目 schema 版本，避免修改数据库全局版本状态。

### 8.2 必需表与约束

以下是逻辑模型，具体 SQL migrations 必须落实主键、外键、唯一约束、CHECK 和索引；时间统一为服务端 UTC 毫秒，API 使用安全整数 id，附件使用随机 UUID，操作使用包含时间的 UUIDv7。

| 对象 | 主要字段与规则 |
| --- | --- |
| `uranus_folders` | id、name、system_key、created_at、updated_at；system_key='default' 唯一 |
| `uranus_notes` | id、folder_id、prev_folder_id、title、snippet、content_json、content_schema_version、revision、pinned、starred、deleted_at、purge_pending、created_at、updated_at；folder_id 有效外键；prev_folder_id 可保留历史 id、不设外键 |
| `uranus_note_search` | note_id（主键及外键）、normalized_title、normalized_text、source_revision；普通表，可从正文重建 |
| `uranus_note_versions` | id、note_id、content_json、content_schema_version、title、char_count、source_revision、created_at；note_id 外键 |
| `uranus_attachments` | id、note_id、object_key（唯一）、file_name、mime、size、etag、status、unreferenced_at、created_at、updated_at、last_error_code；pending/ready/deleting/error；删除失败保留 deleting 及错误码，不恢复 ready |
| `uranus_attachment_refs` | attachment_id、note_id、version_id（可空）；空代表当前正文引用，非空代表版本引用；唯一索引防重复；引用必须属于同一笔记 |
| `uranus_operations` | operation_id、scope、request_hash、status、result_id、result_revision、result_code、lease_owner、lease_until、attempt、created_at、expires_at；幂等回执和进行中状态，不复制大正文 |
| `uranus_maintenance_jobs` | id、kind、status、cursor、lease_owner、lease_until、attempt、next_attempt_at、last_error_code、created_at、updated_at；分批任务、租约和恢复进度 |
| `uranus_runtime_state` | 单例维护状态、generation、maintenance_id、started_at；持久化读写准入控制，不依赖 Worker 内存 |
| `uranus_d1_migrations` | Wrangler 管理的迁移历史 |

P2 标签启用时新增 `uranus_tags` 和 `uranus_note_tags`，现在不要求标签 UI 或空表。

- 索引至少覆盖文件夹/删除状态/置顶/排序、回收站时间、版本 note_id+id、附件 note_id/status、引用 attachment_id/version_id、操作过期时间和任务状态。
- 每个显式索引及触发器名称都带 `uranus_` 前缀。
- 引用唯一约束使用两个部分唯一索引：当前引用 `(attachment_id, note_id) WHERE version_id IS NULL`，版本引用 `(attachment_id, note_id, version_id) WHERE version_id IS NOT NULL`；不能依赖包含 NULL 的普通 UNIQUE 防重。
- 普通列表不可读取正文列；版本列表也不能读取快照 JSON。
- 业务层采用异步 `prepare().bind().first()/all()/run()`，有关联原子性的 SQL 使用 D1 `batch()`，不持有跨网络请求事务。
- 复杂操作应证明条件更新、引用关系和快照的原子性；不能先读后无条件覆盖。
- 整数 revision 从 1 开始递增；服务端时间只用于显示与排序。

### 8.3 行大小与正文派生

D1 当前单个字符串/BLOB/行上限为 2,000,000 字节。因此 v1 不把 JSON、HTML、完整纯文本放在同一业务行。

- 正文 JSON 上限 1,500,000 字节；title 最多 256 字符且 UTF-8 不超过 4KB，snippet 不超过 2KB，其他字段有明确长度限制。
- 规范化纯文本独立放在搜索表行，规范化后 UTF-8 上限 1,500,000 字节；去除重复渲染展开，不能超限后静默丢弃搜索内容。
- JSON、派生数据或行预算任一超限，整个写入拒绝，返回明确 `413`。
- 笔记和快照单行目标不超过 1,800,000 字节，实施时对实际 schema 做边界测试，包含多字节中文和深层节点。
- 控制每次 batch 的语句、参数和执行预算，遵守所选 Cloudflare 套餐限制；大批清理分批进行。

### 8.4 迁移

- SQL 放 `migrations/d1/`，从空库顺序执行，首次迁移建立默认文件夹。
- 迁移是部署步骤；API 请求、Worker 初始化和 Cron 不执行 DDL。
- 已发布迁移不可改写，只能追加；升级先兼容 schema，再发布应用，破坏性修改分版本完成。
- 迁移失败阻止后续发布；Worker 代码回滚不等于 schema 回滚。

## 9. R2 附件与跨资源一致性

### 9.1 上传与读取

- R2 bucket 关闭 r2.dev 和公共域名，访问只通过 `env.UPLOADS`。
- 对象键固定为 `uranus/attachments/<noteId>/<attachmentId>.<safeExt>`；可与其他应用共享 bucket，但维护仅扫描此前缀。
- key 由服务端生成，扩展名来自校验后的 MIME；禁止路径穿越、NUL 和客户端任意 key。
- 单文件最大 **10,000,000 字节**，检查声明长度及实际读入字节，校验 MIME 和魔数；超限 413、类型不支持 415。
- 使用有界的流式 multipart 解析/校验，避免不受限 `formData()` 缓冲与并发内存放大；R2 写入使用流。
- 流程：鉴权与 CSRF → 校验笔记可写 → 创建幂等 pending 记录 → 写 R2 → 标记 ready 并记录 etag → 返回附件 id 与 `/api/attachments/:id`。
- 中断可重试且不重复上传；两端部分成功时保留状态并补偿，未 ready 的对象不进入可用正文。
- 上传及跨笔记复制必须持久化操作租约；完成时再次检查目标笔记未删除、维护 generation 未变且持有当前租约。过期执行者不能将附件发布为 ready；其残留对象由对账清理。重试使用新的尝试对象键（附件 UUID 可按尝试分配），不得与旧执行者同时覆盖同一 key；仅胜出对象关联成功回执。
- 下载先验证会话、附件状态和所属笔记；用 R2 object.body 流式响应，正确设置 MIME、ETag、Content-Disposition、nosniff。
- 每次条件请求也先鉴权；支持 If-None-Match，私有资源使用 `Cache-Control: private, no-cache`，不得放共享缓存；API JSON 使用 no-store。
- P2 PDF 支持 Range、206/416，并且不能绕过鉴权。

### 9.2 引用与删除

- JSON 中附件只存合法本实例附件引用，校验 ready 且属于该笔记。
- 当前正文保存、版本创建/裁剪同步维护 `uranus_attachment_refs`。
- 正文移除图片只删除当前引用；历史版本仍引用的对象保留。
- `unreferenced_at` 表示最近一次进入零引用状态的时间：上传 ready 时初始化，新增任一引用置空，最后一个引用移除时设为当前时间。持续零引用满 24 小时后才可清理，不从最初上传时间计算宽限期。
- 清理在 D1 原子条件操作中再次检查零引用、宽限期及 ready 状态并转换为 deleting，成功后才删 R2。正文/版本写入必须在同一原子操作中校验附件 ready 并写引用；deleting 禁止新增引用，消除“先检查后删除”的竞态。用户主动删除无引用附件可跳过宽限期，但不能跳过该原子检查。
- pending 操作只有在租约失效且完成对账后才清理；不得单凭 created_at 删除仍在上传的对象。过期执行者残留及租约接管按第 11 节处理。
- 硬删除笔记先持久化 purge_pending 并禁止继续编辑，将附件标记 deleting；逐个删 R2，确认结束再删除附件/版本/索引/笔记行。
- R2 删除失败保留记录与进度；不可先级联删除附件行后丢失 object_key。正在删除时 API 可返回 202，UI 明确显示处理中。
- 维护任务幂等，使用有期限租约避免并发重复处理；失败可重试，记录错误码但不记录内容。
- 自动任务只处理已经授权的过期回收站、删除队列和超时无引用对象；异常扫描默认报告，人工选择修复未知孤儿、D1 有记录但 R2 缺失等异常。
- 扫描使用分页游标，不一次遍历全库/全 bucket。
- 每日任务负责发现过期回收站，每 5 分钟调度到期队列。任务状态为 queued/running/retry_wait/succeeded/failed；条件获取租约，提交游标需匹配租约持有者，长任务有界续租。失败指数退避并抖动（最短 1 分钟、最长 1 小时），最多 8 次后 failed，提供人工重试；记录 next_attempt_at，不依赖长驻 timer。

## 10. 登录、会话与安全

### 10.1 配置与登录

| 名称 | 类型 | 含义 |
| --- | --- | --- |
| DB | D1 binding | 结构化数据 |
| UPLOADS | R2 binding | 私有附件 |
| LOGIN_RATE_LIMITER | Rate limiting binding | 登录请求限流，按部署独立 namespace |
| API_TOKEN | Worker Secret | 自生成的应用访问令牌 |
| SESSION_SECRET | Worker Secret | 会话和相关 token 签名密钥 |
| APP_ORIGIN | 可选普通变量 | 精确生产 origin；缺省使用请求 origin |
| APP_ENV | 普通变量 | development/staging/production |
| SESSION_TTL_SECONDS | 可选普通变量 | 默认 86400，上限 2592000 |

- API_TOKEN 和 SESSION_SECRET 各由至少 32 字节安全随机数编码生成，两者不同；只在 Worker Secrets 或本地未提交的 `.dev.vars` 保存。
- 网页仅输入应用访问令牌，不输入 Cloudflare API Token、Account ID、D1 ID、R2 Key 等资源凭据。
- POST `/api/session` 通过 HTTPS 验证令牌，使用恒定时间比较策略，返回统一错误；服务端配置缺失返回 503，不变成公开模式。
- 所有登录尝试在验证令牌前调用 LOGIN_RATE_LIMITER，默认每 IP 每 60 秒 10 次，超限返回 429 和 Retry-After: 60。key 使用可信平台来源 IP 的 HMAC，不记录原始 IP；本地用专门测试 key。此平台限制在各 Cloudflare 位置独立计数，不宣称严格全局防爆破；绑定缺失/故障返回 503，必要时部署者叠加 WAF/Access。
- 登录页及应用不加载第三方统计、广告和远程脚本；无隐藏遥测。

### 10.2 会话

- 使用签名会话或认证加密会话；若使用签名，载荷可读但不可伪造，不能含秘密。禁止仅 Base64 编码而无完整性校验。
- 载荷含随机会话 id、签发/过期时间、当前 API_TOKEN 的 HMAC 指纹，不含原始令牌。
- 每次请求验证签名、期限及当前令牌指纹。Secret 轮换部署生效后旧会话全部失效；文档说明不要混用新旧 Secrets 的渐进发布。
- Cookie 在生产为 HttpOnly、Secure、SameSite=Strict、Path=/，不设 Domain；本地 HTTP 仅在显式 development 模式处理 Secure 例外。
- 设置 Max-Age 和 Expires，与签名载荷过期时间一致，避免误用关闭浏览器即丢失的会话 Cookie；服务端到期校验始终为准。退出用相同 Path/属性清 Cookie。
- 会话默认 24 小时、最多 30 天；有效期内刷新/重开浏览器可继续访问，新设备或过期后重输令牌。
- 前端清空 Token 输入，不写 localStorage/IndexedDB/URL/日志；仅保留非敏感 UI 状态与受控草稿。
- 退出清 Cookie。无状态方案退出不撤销已被盗取的 Cookie；紧急撤销通过密钥轮换完成，必须在 SECURITY 文档说明。

### 10.3 请求防护

- 所有数据 API 统一鉴权；仅静态资源、登录及健康检查最小状态可匿名访问。
- 浏览器写请求严格匹配 Origin，并校验与会话绑定的 CSRF token；普通请求走 Header，beacon 走专用 body 字段。
- 登录请求执行 Origin 校验；session 状态响应可向已登录客户端提供 CSRF token。
- 同源 Cookie 是 v1 唯一业务认证方式；P2 Bearer 模式另行定义，不接受 query Token。
- HTTPS、CSP（自托管脚本，img 仅 self/blob 等必要源）、frame-ancestors none、nosniff、Referrer-Policy 和 Permissions-Policy；生产自定义域名使用 HSTS。
- Vite 所有 `VITE_*` 值视为公开数据，不能放 Secrets；shared 代码只含 DTO/Schema，不能把服务端模块打入客户端。
- 登录、令牌轮换、绑定缺失、坏签名、跨域写请求必须有负向测试。
- Cloudflare Access 可作为额外保护，不替代应用鉴权。

## 11. HTTP API 契约

成功响应使用明确 DTO；列表统一 `{ items, page, pageSize, hasMore }`，维护扫描另用 cursor。分页上限由服务端强制。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET / POST / DELETE | `/api/session` | 登录状态及 CSRF / 登录 / 退出 |
| GET | `/api/health` | 匿名仅总体状态；登录后给组件摘要 |
| GET / POST | `/api/folders` | 列表含计数 / 创建 |
| PATCH / DELETE | `/api/folders/:id` | 重命名 / 删除并软删除其笔记 |
| GET / POST | `/api/notes` | 分页列表搜索 / 新建 |
| GET / PATCH / DELETE | `/api/notes/:id` | 详情 / 条件更新 / 软删或 `hard=1` 清除 |
| POST | `/api/notes/:id?beacon=1` | 退出保存，语义同正文 PATCH |
| POST | `/api/notes/:id/restore` | 从回收站恢复 |
| POST | `/api/notes/empty-trash` | 创建分批清空任务 |
| POST | `/api/attachments` | multipart 上传 |
| POST | `/api/attachments/:id/copy` | 复制到 target_note_id，生成目标专属附件，携带 operation_id |
| GET / DELETE | `/api/attachments/:id` | 鉴权流式读取 / 请求删除无引用附件；仍有引用时 409 |
| POST | `/api/import/markdown` | 导入并创建笔记 |
| GET / POST | `/api/notes/:id/versions` | 分页列表 / 手动标记 |
| GET | `/api/notes/:id/versions/:vid` | 快照内容 |
| POST | `/api/notes/:id/versions/:vid/restore` | 原子备份当前并恢复 |
| GET | `/api/maintenance/attachments` | 分页一致性审计，只报告 |
| POST | `/api/maintenance/attachments/repair` | 已确认项目的修复任务 |
| GET | `/api/maintenance/jobs/:id` | 查询清空/修复/删除任务进度 |
| POST | `/api/maintenance/jobs/:id/retry` | 显式重试失败任务，需 operation_id |
| GET | `/api/operations/:id` | 查询幂等状态及固定回执，不返回当前正文 |
| GET / POST / DELETE | `/api/maintenance/mode` | 查询 / 进入写暂停 / 经确认退出；返回 maintenance_id |
| GET | `/api/maintenance/backup` | 暂停且排空后按白名单分页导出逻辑记录及清单 |
| POST | `/api/maintenance/restore` | 仅空目标、维护模式下分批导入，按备份及批次 id 幂等 |

- 列表支持 folder_id、starred、deleted、q、sort_by、sort_dir、page、pageSize；同时作用时取交集。
- 单篇现有笔记修改请求带 expected_revision；新建无基准 revision。文件夹删除、清空等批量操作以任务处理，每篇使用条件更新并对冲突记录重试/报告，不能无条件覆盖并发编辑。新建/上传/复制/导入/手动快照/恢复及维护写操作携带 operation_id。
- 幂等键按实例唯一，request_hash 包含规范化方法、路径、业务负载及文件摘要，不含 Cookie/CSRF 等易变字段。同 id 不同负载返回 409；重试不得将新正文套用旧 id。
- 操作状态 pending/succeeded/failed；pending 重复请求返回 202、operation_id 和轮询入口。仅当前租约可提交，租约失效后条件接管并先核对 D1 结果/R2 对象，不盲目重做；终态失败记录固定业务错误，临时故障保留可恢复状态。
- D1 成功回执与业务提交同一原子批次落库。成功重放返回固定 `{ operation_id, note_id, applied_revision }`（上传另含 attachment_id，任务另含 job_id），不返回重试时最新正文；需要当前状态另发 GET。无修改操作也固定其回执。
- 完成记录至少保留至完成时间与 operation_id 内时间两者较晚值加 7 天，pending 不按到期时间直接删除。新操作采用 UUIDv7，拒绝超过服务端时间 5 分钟或早于 7 天的 id；同 id 重试不改变时间。已存在记录优先返回其状态，记录已清理且超窗口返回 409 `OPERATION_EXPIRED`，不能当新建；客户端应查询资源并提示确认，不自动换 id 重建。客户端时钟偏差须给出可操作提示。
- 不存在资源返回 404，错误结构统一为 `{ error: { code, message, requestId } }`；冲突可额外携带 latest revision/内容。
- 区分 400 校验、401 未认证、403 Origin/CSRF、404 不存在、409 冲突、413 超限、415 类型、429 限流、500 内部错误、503 配置/资源暂不可用。
- 原始 SQL、堆栈、资源 ID 和 secrets 不出现在用户错误信息中。

## 12. 工程结构与部署配置

```text
uranus/
├── src/                    # 浏览器端
│   ├── main.tsx
│   ├── app/                # 路由、providers、登录和主界面
│   ├── components/editor/  # TipTap 和 NodeView
│   ├── api/                # API client、Query keys、hooks
│   └── state/              # UI store、草稿与保存队列
├── worker/
│   ├── index.ts            # fetch 和 scheduled exports
│   ├── middleware/         # 配置、auth、CSRF、错误、日志
│   ├── routes/             # Hono API
│   ├── services/           # 保存、版本、附件与维护业务
│   └── repositories/       # 显式接收 D1/R2
├── shared/                 # DTO、校验 schema、内容 schema
├── migrations/d1/
├── scripts/                # 运维备份、空目标恢复及校验工具
├── tests/                  # unit、Workers integration、e2e
├── public/                 # 图标和静态响应头
├── doc/                    # 本文及部署、备份、API 文档
├── index.html
├── vite.config.ts
├── wrangler.example.jsonc
├── .dev.vars.example
└── package.json
```

Wrangler 模板示意（部署者复制后填写自己的资源；Vite 插件生成构建输出配置和 assets 目录）：

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "uranus-notes",
  "main": "worker/index.ts",
  "compatibility_date": "2026-10-24",
  "assets": {
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "<YOUR_DATABASE_NAME>",
    "database_id": "<YOUR_DATABASE_ID>",
    "migrations_dir": "migrations/d1",
    "migrations_table": "uranus_d1_migrations"
  }],
  "r2_buckets": [{
    "binding": "UPLOADS",
    "bucket_name": "<YOUR_BUCKET_NAME>"
  }],
  "ratelimits": [{
    "name": "LOGIN_RATE_LIMITER",
    "namespace_id": "1001",
    "simple": { "limit": 10, "period": 60 }
  }],
  "vars": { "APP_ENV": "production" },
  "triggers": { "crons": ["0 3 * * *", "*/5 * * * *"] }
}
```

- Cron 表达式为 UTC：每日 03:00 发现过期回收站，每 5 分钟处理到期删除/重试任务，两个触发重叠时通过租约去重。每次限制条数、子请求和执行预算，未完成保留游标交下一次处理，不依赖长时间 setInterval。
- LOGIN_RATE_LIMITER 的 namespace_id 示例须替换为账号内为本部署分配的正整数字符串；不同环境不能意外共享计数。配置语法及本地模拟能力按锁定 Wrangler 版本验证。
- 迁移路径、bindings 和配置模板统一，不同时维护两套互相覆盖的 Dashboard/Wrangler 真相；声明式配置为基线。
- Secrets 不写入上述配置，配置检查覆盖 DB、UPLOADS、LOGIN_RATE_LIMITER、API_TOKEN、SESSION_SECRET。
- 配置缺失 API 返回 503，前端显示配置错误；禁止自动回退公开访问或本地存储。

目标脚本契约（实现时按锁定版本验证生成配置路径）：

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "deploy": "npm run build && wrangler deploy",
    "cf:typegen": "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts",
    "db:migrate:local": "wrangler d1 migrations apply DB --local",
    "db:migrate:remote": "wrangler d1 migrations apply DB --remote",
    "test": "vitest run",
    "test:e2e": "playwright test"
  }
}
```

还需提供覆盖浏览器、Worker、shared 的 typecheck 脚本。Vite preview 必须通过 Cloudflare 插件运行构建后的 Worker，并验证 `/api/*` 和本地 bindings，不能仅启动静态文件服务器。

## 13. 本地开发与自部署

### 13.1 本地

```bash
npm ci
cp wrangler.example.jsonc wrangler.jsonc
cp .dev.vars.example .dev.vars
# 填写本地配置，生成两个不同的开发随机 secret
npm run cf:typegen
npm run db:migrate:local
npm run dev
```

- 从第一天使用本地 D1/R2 模拟，持久状态在 `.wrangler/` 中；dev、preview 和本地迁移必须使用同一已验证的状态目录。
- `.dev.vars` 放开发 API_TOKEN、SESSION_SECRET；本地 APP_ENV 必须显式为 development，通过受支持的配置覆盖生产模板并测试。
- 本地运行不需要连接生产资源，不能默认开启 remote bindings。
- README 给出具体 URL、登录方式、重启保留数据及精确清空本地测试数据的步骤。
- 类型及构建检查后，运行 `npm run build` 和 `npm run preview` 验证生产构建。

### 13.2 首次部署

1. Fork/clone，安装锁定依赖。
2. 创建或选择自己的 D1、私有 R2；共享 D1 要确认不存在另一套 Uranus schema。
3. 填写 bindings 配置、环境及可选 APP_ORIGIN，生成随机 Secrets。
4. 使用 Wrangler 登录，执行远端 migrations；初始化失败不得发布可用应用。
5. 在 Worker 创建/首次部署流程中配置 Secrets；若平台需要先创建 Worker，则先发布会拒绝访问的版本，再配置 Secrets 并完成发布，不允许临时公开数据。
6. 构建并部署；验证登录、保存、搜索、上传、恢复和删除。
7. 可选绑定自定义域名，更新 origin 配置并验证 HTTPS/Cookie/CSRF。

CLI 文档提供 create D1、create R2、secret put、migrations apply 和 deploy 的完整可复现命令。Dashboard 文档说明资源与 Secrets 配置，并通过 Workers Builds/CI 执行构建和迁移；不能宣称仅点击 binding 即自动完成 schema 初始化。

### 13.3 环境与升级

- development、staging、production 的 D1/R2、Secrets 和域名隔离，binding 名称保持一致。
- 发布前检查 release notes、容量和备份；先 migrations，再 deploy，再冒烟测试。
- 不硬编码官方域名。更换数据 binding 是部署管理操作，网页不支持动态填写数据库凭据。
- 生产部署不要求浏览器持有 Cloudflare Token；CI 需要的平台凭据只存在 CI Secrets，权限最小化。

## 14. 备份、恢复与维护

### 14.1 v1 交付边界

- 提供可执行、可断点续传的运维工具和演练文档，不建设可视化备份中心。工具通过同源 HTTPS API 登录获得 Cookie/CSRF，令牌经隐藏输入或受保护环境变量传入，不放命令行参数或日志；不新增 Bearer 认证或浏览器云平台凭据。
- 工具显式发送目标 Origin，并沿用 Cookie/CSRF 校验；维护请求携带 maintenance_id 以关联当前作业，不能将该 id 当作鉴权凭证。恢复期间的工具读取通过专用维护 API 完成，普通数据路由继续拒绝访问。
- D1 与 R2 是两个资源，备份必须包含业务逻辑记录和附件实际字节。manifest 包含备份格式版本、应用版本、迁移版本、内容 schema 版本、记录数量、R2 key/size/etag 及每个导出文件/附件的 SHA-256；ETag 不替代内容校验和。
- 仅导出明确白名单中的笔记、文件夹、版本、附件及引用，附迁移版本元信息。搜索表恢复后重建；不恢复旧会话、操作租约或运行中任务，不读取共享 D1 的其他应用对象。

### 14.2 一致性与中断

- 维护模式持久化在 `uranus_runtime_state`，按 normal → draining → frozen 转换。进入时递增 generation，原子关闭新写入准入；所有普通写入、上传完成和 Cron 提交均在提交条件中校验模式/generation，不能仅在请求入口检查。
- draining 阶段等待在途 D1 写入及 R2 上传/删除/复制完成或安全终止，按持久化租约和操作状态对账。租约过期本身不是外部 I/O 已停止的证据；无法确认稳定时拒绝开始备份，不把超时当排空成功。
- frozen 时允许鉴权读取和备份，不执行业务写入或 Cron 清理；写入返回 503 `MAINTENANCE_MODE`。备份游标绑定 maintenance_id/generation，暂停状态解除后旧游标不可续用，必须新建备份。
- 工具按页读取逻辑记录并流式下载附件，文件及附件校验完成后才写成功标记。中断保持维护模式、记录进度；重新登录后可继续，退出维护须显式确认，不因工具失联自动解除冻结。不完整备份不可用于正式恢复。

### 14.3 恢复与验证

- 只允许恢复到新建或经确认无业务数据的目标 Uranus 空间，v1 不原地覆盖有数据实例。目标可共享 D1/R2，但本项目前缀必须为空（迁移创建的默认文件夹例外），其他应用对象不受影响。
- 工具先校验 manifest/schema 兼容性，执行目标 migrations，再进入专属恢复维护模式；按 backup_id、批次 id 和校验和幂等导入。恢复接口分别支持有界 JSON 批次和附件字节流，显式记录完成进度；同批次不同内容返回 409。普通上传接口不能绕过冻结。
- 保留业务 id 和关联关系，先导入对象及依赖记录，再校验引用、重建搜索表和检查计数/哈希；失败保持不可写、不发布部分恢复的数据为可用实例。恢复中的读取仅开放给维护工具，普通数据 API 返回 503。
- 完成至少 20 篇笔记（不足时全部）及其历史图片的抽样验证，所有文件校验和/长度通过后才确认解除维护。文档解释备份含明文私人内容，需保护本地文件及存储介质。
- 共享 D1 的整库 Time Travel 会影响其他应用，不能当作 Uranus 单应用恢复。维护 API 提供任务状态、进度、失败数及重试，分批执行遵守请求与查询预算。

## 15. 开源、隐私与可观测性

- 仓库提供 README、LICENSE（发布前明确，建议 MIT）、CONTRIBUTING、SECURITY、AGENTS、部署、bindings、API、备份恢复文档。
- AGENTS 和 README 以本规格为开发基线，描述目标架构并区分已实现状态。
- 示例文件仅含占位符；忽略实际 wrangler 配置、`.dev.vars`、敏感 `.env`、`.wrangler/`、dist、备份及测试用户数据，同时显式保留 `.example` 文件。
- Git tag/Release 使用语义化版本，列明破坏性 API/schema、binding/secret 变化和升级步骤。
- 锁定依赖，自动检查安全更新；升级 Hono 等依赖先检查公告，再执行鉴权与 API 回归。
- 日志仅包含 requestId、路由模板、状态、耗时、操作分类、版本/环境、读写量与错误码。
- 禁止日志包含 Token、Cookie、Authorization、完整 URL 查询、正文、标题、搜索词、附件内容或真实资源标识组合；自动请求日志也必须审计。
- 健康检查只读，区分 binding 存在和实际 D1 可达；R2 未进行探测时不能把“已绑定”声称为“读写正常”。匿名仅总体状态，详细诊断需登录。
- 不承诺免费套餐可容纳任意笔记量；文档说明版本、搜索表、扫描及附件占用，并提供容量评估方法。

## 16. 测试与验收

### 16.1 必需测试

- 单元：内容派生与清洗、大小/结构预算、排序白名单、保存队列、会话签名/过期/轮换、CSRF、日志脱敏。
- Workers 集成：真实本地 D1/R2 bindings 的 migration、CRUD、中英文子串及规范化搜索、乐观锁、幂等、快照和引用清理；搜索表重建和旧内容 schema 迁移。
- 并发：同 revision 两次保存仅一次成功；失败保存不写搜索表/快照；旧响应不覆盖新编辑或删除新草稿；元数据与正文串行；提交成功但响应丢失后重放固定回执；租约接管旧执行者不能提交；幂等窗口过期不重复创建。
- 附件：跨笔记复制成功/中断/重试；最后引用移除重新起算宽限期；GC 与保存竞争仅一方成功；版本裁剪、删除失败和孤儿对账。
- 故障：D1 成功/R2 失败与相反情况、半途硬删除、任务重入、租约过期、备份/恢复中断。
- 边界：1,500,000 字节正文与整体行预算、中文、10,000,000 字节附件、退出请求预算、IndexedDB 满/禁用/乱序写入/多标签页、超长关键词。
- 隔离：创建非 uranus_ 哨兵表与非 uranus/ R2 对象，初始化、升级、清理、逻辑恢复后其结构和内容保持不变。
- 安全：未登录不能读写数据/图片；登录限流；非法 MIME、伪造魔数、CSRF、XSS、路径穿越、Cookie 属性和敏感缓存。
- 浏览器：登录→建笔记→编辑→刷新→搜索→上传→版本预览/恢复→回收站→硬删除；重启 Worker 不丢持久数据。
- UI：v1 格式与基础表格、图片缩放终止、只读 NodeView、查找、菜单、快捷键、深色主题和窄屏操作；P2 不出现伪可用入口。
- 运维：维护状态跨 Worker 重启有效；冻结与在途上传/Cron 竞争、备份断点续传及失效游标、损坏文件拒绝恢复、非空目标拒绝恢复、恢复中断重试。
- 路由：`/notes/:id` 刷新正常；直接访问不存在 `/api/*` 返回 JSON 404；附件导航不会返回 SPA HTML。

### 16.2 v1 发布退出条件

1. 单一仓库构建并部署 React SPA 和 Hono Worker，绑定自己的 D1/R2 即可使用。
2. 新 Cloudflare 账号根据公开文档独立完成部署，无维护者资源依赖。
3. Token 登录、有效会话重用、过期/轮换失效与配置缺失拒绝全部通过。
4. v1 产品能力完整，P2 在界面和文档中明确标识，不能出现无效入口。
5. 自动保存确认语义、冲突恢复、退出风险提示可靠，无静默覆盖。
6. 数据库对象前缀、R2 命名范围和共享资源隔离测试通过。
7. 历史版本可恢复其图片，硬删除失败可重试且不丢追踪记录。
8. typecheck、单元/集成、浏览器测试及 Worker preview 通过，完成 staging 冒烟。
9. 发布内容不含真实 Secrets/资源配置/数据；完成许可证和安全报告渠道。
10. 完成一次 D1+R2 备份恢复演练，并公布可恢复范围和容量限制。

### 16.3 容量与性能基线

- 提供可复现测试数据：1,000 和 10,000 篇两档，常规正文平均约 10KB UTF-8，中文/英文各半，另含 20 篇接近正文上限的边界笔记。历史版本和附件容量另计，不能仅按笔记数量估算。
- 在 staging 记录套餐、Worker/D1 地域、浏览器/设备、数据规模和并发数。预热后每个场景至少 100 次，单用户并发 1，区分客户端网络耗时、Worker 墙钟耗时、CPU 和 D1 rows_read；不得把本地模拟数据当生产性能。
- 初始验收目标：普通列表 Worker 处理 p95 ≤300ms；1,000 篇子串搜索 p95 ≤1s，10,000 篇 ≤2s。覆盖有/无匹配、短词、中文、范围过滤和末页查询。此为待验证目标，不是平台保证；未达标须优化或明确收紧发布容量边界并更新规格，不能无证据承诺支持。
- 桌面基准设备常规正文连续输入的交互延迟 p95 ≤100ms；大正文另测打开、查找、草稿落盘和保存耗时，不能因同步序列化持续卡住输入。报告具体设备及测试步骤。
- 无外部故障、无退避时，100 个小附件的已入队删除任务目标在 10 分钟内完成；报告积压、重试和超限情况，失败不以“已删除”隐藏。新增每日过期发现延迟不计入队列执行时延。

## 17. 实施顺序

| 阶段 | 交付 | 完成条件 |
| --- | --- | --- |
| M1 基础 | Vite React、Hono、Worker、bindings、配置模板、开源文件 | dev/preview 同源 API 和本地资源可用 |
| M2 数据与安全 | migrations、默认文件夹、session/CSRF、错误契约、隔离测试 | 未登录不可读写，部署拒绝缺失配置 |
| M3 核心编辑 | 三栏、CRUD、TipTap、自动保存、revision/幂等、本地草稿 | 多设备并发和保存失败测试通过 |
| M4 笔记组织 | 文件夹、排序、星标、回收站、普通表子串搜索、Cron | 搜索正确，清理可恢复且有界 |
| M5 附件与版本 | R2、引用关系、快照、恢复、删除队列、审计 | 失败补偿与历史图片完整 |
| M6 交互完善 | 基础表格、外部链接、输入规则、只读、主题、导入 | 浏览器交互验收通过 |
| M7 发布 | CI、文档、容量说明、备份恢复、盲部署 | 满足全部 v1 发布退出条件 |

## 18. 官方参考与核对要求

- [Cloudflare React + Vite](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/)
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [React Router 模式选择](https://reactrouter.com/start/modes)
- [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/)
- [D1 SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- [D1 资源限制](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 导入导出限制](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [R2 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

平台功能和限制会变化。实施时以锁定工具版本和当时官方文档核对配置及配额；本文中的需求上限是应用约束，不能因平台上限提高自动放宽。
