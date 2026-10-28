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

主要动作：

```text
state, accounts.save/test/remove, sync
search, message.read, thread.read
drafts.save/reply/delete/cancel, send.preview, preview.confirm/reject
messages.action, folders.action
rules.preview/save/enable/apply
events.save/list/delete/import/export/invite/rsvp
resources.save/delete, contacts.import/export
attachments.upload/read, mail.import/export, files.save
backup.create/restore, jobs.cancel/retry, notifications.dismiss
```

发信审批绑定草稿版本、发件身份/SMTP 配置和发送时间。预览期限 30 分钟；确认只能通过 UI。草稿的 `status`、`approvalId`、`sendAt` 不接受草稿保存输入。不可逆操作的远程结果未知时，不自动重试。文件夹复制逐封保存 pending/running/done/unknown 检查点；中断后继续未开始项目，未知项目保留以供核查。

本地规则不创建网易网页过滤器。垃圾邮件动作只移动文件夹。彩色标签只保存本地状态。日历邀请/回复先生成 MIME 草稿，之后走相同发送预览，不直接发信。邮箱正文不授予外部工具权限，邮箱助手预设不附带 shell。

边界：当前凭据实现仅支持 Windows；无 Google/Microsoft 专用 OAuth、外部日历双向同步、跨设备同步、公网打开追踪、独立常驻服务。真实服务端兼容性以验收记录为准。
