# 实现与接口

`dsh/index.mjs` 管理插件生命周期和 profile 数据目录；`dsh/bridge.mjs` 为原生 UI 提供 Typert 接口；`dsh/agent.mjs` 在邮箱助手预设中注册九组原生工具。两种入口都调用 `MailService.invoke`。

| 层 | 文件 | 责任 |
|---|---|---|
| UI | `ui/plugin.jsx`, `ui/workbench.jsx`, `ui/styles.css` | DSH slots、响应式工作台、用户确认、文件交付 |
| 业务 | `src/service.mjs` | 权限、预览、持久队列、同步协调、规则、资源与备份 |
| 协议 | `src/mail.mjs` | IMAP ID/TLS、UIDVALIDITY、能力检查、MIME、SMTP |
| 存储 | `src/store.mjs` | SQLite WAL、FTS5、中日文检索词、版本迁移与一致性备份 |
| 日历 | `src/calendar.mjs` | ICS、时区注册、重复与例外、邀请身份和版本 |
| 凭据 | `src/vault.mjs` | Windows CurrentUser DPAPI，stdin/stdout 传递、无明文日志 |

同步按账号串行使用 IMAP 连接。新邮件先取元数据与正文，附件懒加载。服务器支持 CONDSTORE 时读取变化标记，不支持时读取 UID/flags；UID 集合用于发现其他客户端的删除。同步后回到收件箱，ImapFlow 的自动 IDLE 监听新消息；默认 120 秒巡检。认证错误暂停自动尝试，网络错误指数退避并加抖动。

邮件数据库 ID 是插件稳定标识。远程位置唯一键为账号、文件夹、UIDVALIDITY 和 UID。跨文件夹副本拥有独立实例 ID。附件保存为散列命名的内容文件，原邮件路径不直接接受外部参数。

业务接口以 `{action,...fields}` 调用。Agent 工具分组限制可用 action；服务端再次区分 `human`/`agent`。`human` 来自受 DSH 连接保护的 UI bridge，不从工具 JSON 读取。此机制是插件业务权限边界，不是隔离同一 Windows 用户可运行的任意程序。

`thread.read(id,limit?,offset?)` 使用 `src/conversations.mjs` 的引用关系连通分量，按账号及去除回复前缀后的主题隔离；连接 Message-ID、References 和 In-Reply-To，兼容原信缺失及只引用中间回复。相同 Message-ID 的文件夹副本在分页前去重，优先保留当前阅读实例；`current` 单独返回当前邮件摘要，使其不在当前分页时仍可标明当前位置。结果包含准确总数及下一页 offset，缺失/已删除文件夹不参与展示。

分组索引只读取邮件标识、主题及引用头，按账号按需建立；真实引用元数据新增、修改、删除或外部数据库写入后失效，已读等标记变化复用缓存。普通搜索不强制构建索引，当前页聚合显式请求分组元数据。旧数据库无需迁移，既有 `thread_id` 筛选保留兼容；阅读区和 Agent 的 `thread.read` 使用新的往来查询。事务回滚清除分组缓存，防止未提交引用留下错误关联。

阅读 HTML 的有效 HTTP/HTTPS 锚点保留 href，强制独立目标及 `noopener noreferrer`；iframe 仅增加弹出页面相关的 sandbox 权限，邮件自身仍没有脚本或同源权限。正文点击行为在隔离 Host/Edge 中以本机拦截的目标页验证，包含目标页可正常运行及 opener 为空；不自动访问邮件外链。

主要动作：

```text
state, accounts.save/test/remove, sync
search, message.read, thread.read
drafts.save/reply/delete/cancel, send.preview, preview.confirm/reject
messages.action, folders.action, folders.color
rules.preview/save/enable/apply
events.save/list/delete/import/export/invite/rsvp
resources.save/delete, contacts.import/export
attachments.upload/read, mail.import/export, files.save
backup.create/restore, jobs.cancel/retry, notifications.dismiss
```

`search` 支持 `sent: true`：按账号优先使用 `account.folders.sent`，无手动映射时使用有效的 `\Sent` 标识；范围为空时直接返回空结果。`folders.color` 仅接受 human UI 调用，字段为文件夹 `id` 与六位十六进制 `color`，空字符串恢复默认。颜色保存在已有文件夹实体中，同步写回计数时保留最新本机颜色，重命名保留、复制使用默认色。上述偏好不触发 IMAP 操作。

`settings.save` 增加 `folderSort`，允许 `name-asc`、`name-desc`、`count-desc`，默认 `name-asc`。设置与颜色沿用 SQLite 实体和现有备份，不需要新增表或迁移。UI 在排序保存失败时恢复原选择；显示排序不依赖实体更新时间。

`message.read` 返回 `locations: [{id, folderId}]`，按同账号与相同 RFC Message-ID 查询实际缓存位置，排除失效文件夹；无 Message-ID 时只返回当前实例。单封整理弹窗调用现有 `messages.action` 队列，完成并确认结果后关闭，失败或结果未知时显示核查提示。跨账号副本通过各自账号查看，不合并成跨账号位置标签。

`search.items` 同样携带 `locations`，只针对本页 ID 通过一次批量查询获得；查询使用消息 ID、账号/Message-ID 和文件夹实体的既有索引，列表不逐封调用 `message.read`。列表角标和阅读标签共同过滤 INBOX、失效与重复位置，按名称稳定排列；多个项目以分色角标显示。颜色从当前文件夹实体读取，修改颜色后同步更新；24 色板扩充保留原有头像用色。

`settings.save` 的 `loadRemoteImages` 仅接受布尔值，默认 `false`，随现有实体与备份持久化。正文仍在 sandbox iframe 内进行 DOMPurify 清理与 CSP 限制；设置开启时只允许 HTTPS 远程图片，CID 图片继续通过附件接口按需读取。单封覆盖值仅在当前 Reader 内保存。

UI 复用未变化的资源对象引用，邮件查询按 `mailVersion`、账号、文件夹及筛选变化刷新。`mailVersion` 包括本连接邮件变动计数、SQLite `data_version` 及最近的未到期延后时间，兼顾外部写入和延后到期。隐藏邮件页暂停查询；正文只在 HTML、图片附件或加载策略改变时重新准备。索引覆盖统计按版本缓存，FTS 子查询直接返回对应消息的 rowid。

日历使用容器高度、ResizeObserver、小月历与多个可见日历选择；无数据变化时不重新获取事件。事件结束状态按 occurrence 的结束时间判断，全天结束边界使用显示时区，每 30 秒本地更新显示；配色转换不改写事件记录。

发信审批绑定草稿版本、发件身份/SMTP 配置和发送时间。预览期限 30 分钟；确认只能通过 UI。草稿的 `status`、`approvalId`、`sendAt` 不接受草稿保存输入。不可逆操作的远程结果未知时，不自动重试。文件夹复制逐封保存 pending/running/done/unknown 检查点；中断后继续未开始项目，未知项目保留以供核查。

本地规则不创建网易网页过滤器。垃圾邮件动作只移动文件夹。彩色标签只保存本地状态。日历邀请/回复先生成 MIME 草稿，之后走相同发送预览，不直接发信。邮箱正文不授予外部工具权限，邮箱助手预设不附带 shell。

边界：当前凭据实现仅支持 Windows；无 Google/Microsoft 专用 OAuth、外部日历双向同步、跨设备同步、公网打开追踪、独立常驻服务。真实服务端兼容性以验收记录为准。


Agent 操作成功后，`MailService.invoke` 按操作类型生成当前会话的工作台展示请求。请求只保存在 Host 内存中，包含 epoch/递增 sequence、目标页面、稳定实体 ID 或校验后的邮件查询，5 分钟过期，不写入数据库或备份。`display:false` 跳过自动展示；`workbench.show(page,id?,query?)` 显式定位已有邮件、草稿、事件、待办、联系人或规则。

`workbench.state`、`workbench.ack` 和 `exports.read` 仅供 human UI 调用。请求会话来自实际 Agent 执行上下文；全局工作台和其他会话无法领取。旧 ID 的 ack 不删除新请求。当前邮箱助手会话每秒只轮询轻量请求状态，新请求展开并聚焦右侧工作台，由页面刷新业务状态后呈现、确认消费。页面保留已应用 sequence，避免轮询重复下载或重复打开弹窗。草稿开始编辑后及弹窗未关闭时暂缓展示；干净草稿按 revision 重新挂载以显示 Agent 修改。发送预览复用原服务端确认流程。展示失败返回独立 `workbench.status=unavailable`，不把已保存的业务操作报为失败，避免误重试。
