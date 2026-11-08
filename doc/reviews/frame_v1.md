本文记录对当前 Uranus 代码库的一次架构走查结论，作为后续重构与功能迭代的参考。评估基线为 v6 实施后的当前代码状态。



总体评价



服务端设计水平高于前端：一致性、幂等、多用户隔离的处理严谨；前端持久化链路（草稿 / 保存队列 / 乐观锁）设计可靠，但组件结构与渲染路径已显现复杂度失控迹象。



做得好的设计



数据一致性







保存链路幂等完整：`operation_id` + `uranus_operations` 回执表 + UUIDv7 时间窗 + 租约接管，重试不产生重复写入。





乐观锁原子正确：`WHERE id=? AND revision=?` 条件更新，并以 `last_operation_id=?` 将搜索表、版本快照、回执更新绑进同一 batch 成功条件，零行即失败。





附件生命周期为完整状态机（`pending → ready → deleting`）+ `unreferenced_at` 宽限 + `uranus_attachment_refs` 引用计数；硬删除先持久化再删 R2。





多用户隔离落在 SQL 层（`user_id IS ?` 拼入每个查询/更新条件），不依赖应用层自觉。





服务层显式接收 `D1Database`/`R2Bucket`，不依赖 Hono Context，可测试性好。



工程纪律







迁移只追加不改写；`uranus_` 前缀不污染共享 D1；Wrangler 迁移表独立。





`shared/` 前后端共用 Zod 与内容校验，避免两端规则漂移。





测试分层合理：单元 / Workers 集成（真实 binding）/ Playwright。





规格文档与实现记录（plan_v1–v6、implementation-v*）与代码对应。



可改进项



前端结构（主要债务）







**组件臃肿**





`src/app/Workspace.tsx` 集中路由、查询、保存队列、菜单、导入、回收站等十余项职责。





`src/components/editor/NoteEditor.tsx` 约 600 行，含 5 个自定义扩展、全部工具栏、粘贴/上传/标题逻辑。





建议拆分：`useNoteQuery`/`useSaveQueue` hooks、`editor/extensions/` 目录、独立 `TitleField`/`PasteHandler`/`UploadFlow`。







**渲染路径耦合（IME 中断根因）**





每次按键：`onChange → enqueue → report → setSaveStatus` → Workspace→NoteEditor 整树重渲染 → `useEditor` 收到新 `editorProps` 对象 → `view.setProps` → `domObserver.flush()` → IME composition 被强制提交。





修复方向：保存状态移出 React 渲染路径（Zustand 订阅或 ref）；`useEditor` 的 options/editorProps 用 `useMemo`/`useCallback` 固定引用；受控标题 textarea 加 composition 守卫。







**schema 版本号散落**





`1|2|3|4|5` 字面量至少出现在 `src/api/client.ts`、`worker/services/notes.ts`、`shared/dto.ts`、`src/state/drafts.ts` 等处。





应收敛为 `shared` 中 `SUPPORTED_SCHEMA_VERSIONS`/`CURRENT_SCHEMA_VERSION` 常量 + 类型推导，每次升级只改一处。







**偏好存取散乱**





`readPreference`/`localStorage.getItem` 直接散在组件中（行号、只读、宽度、字号、同步间隔），建议收敛到 `state/ui.ts` 统一读写。



传输与存储效率







**整篇 JSON 上行且未压缩**





`PATCH /api/notes/:id` 每次提交完整 TipTap JSON；浏览器请求体不压缩。





可行改造：客户端 `CompressionStream` + `Content-Encoding: gzip`；Worker 中间件 `DecompressionStream` 解压并限制解压后大小（防 zip bomb）；FormData（附件）跳过。协商式 header 天然向后兼容。







**版本快照全量存储**





每次内容变更快照整份 `content_json`，D1 存储随历史线性放大。可评估快照去重或差量存储，但需权衡恢复原子性与实现复杂度。







**bodyLimit 全局 10.5MB**





`accountApp` 对 `/api/*` 统一限制；未来支持更大附件需拆为路由级限制。



潜在正确性细节







**`queueFor` 在渲染期执行副作用**





`updateRevision`/`setSyncInterval` 在 render 中被调用；StrictMode 双渲染会执行两次（当前操作幂等所以无害），建议挪入 `useEffect`。







**`note` prop 陈旧性**





`queueFor(selectedNote)` 使用闭包中的 note，revision 靠 `Math.max` 兜底。目前正确但脆弱，建议补注释或测试固化该契约。



架构边界（记录在案，非当前缺陷）







**单写者乐观锁模型**





跨设备/多端同时编辑直接 409；如未来需要协同，须切换 TipTap steps/CRDT 保存协议。







**`uranus_note_search` 字面值搜索**





符合 v1 规格（禁用 FTS 虚表）；数据量增大后 `LIKE` 全扫描是已知边界，FTS5 为预留演进路径，需经需求变更。



优先级建议



| 优先级 | 项 | 理由 |

|---|---|---|

| 高 | #2 渲染路径解耦 + #8 | 直接造成 IME 输入中断，也影响其他交互流畅性 |

| 高 | #3 版本号常量收敛 | 每次 schema 升级需改多处，漏一处即线上 400 |

| 中 | #1 组件拆分 | 复杂度临近失控，继续叠加功能（附件/标签/缩进）会加速恶化 |

| 中 | #5 上行压缩、#6 快照策略 | 上行流量与快照存储的长期成本 |

| 低 | #4 #7 #9 #10 #11 | 整洁度与演进空间，不阻塞当前功能 |



结论



持久化与一致性设计可以放心信任；前端组件组织和渲染路径是最需要投入重构的部分，且与已知 IME 输入中断问题同源，建议优先处理。