# 有界兼容与 Windows 自动回归

宿主与所有 DSH peers 使用同一范围：`>=0.2.2-rc.2 <0.2.3-0`。Mail 0.1.29 的同一个 tarball 在 Windows 的 rc.2 和 rc.3 隔离 SDK 中验证通过，因此保留 rc.2 下界。范围覆盖后续同补丁 RC 和 `0.2.2` 正式版；它不是对所有未来版本的实测承诺。`0.2.3-0`、`0.2.3-rc.1` 及更高版本均需另行评估。

工作流和 release 选择、去重逻辑复用自 [RAG Memory 试点 6c0ea2f](https://github.com/xiaoxinblast/DSH-RAG-Memory/blob/6c0ea2fb3ed4b2588b7fcceddf076407920f5b17/docs/compatibility-ci.md)，Mail 保留自己的范围、依赖列表和业务断言。

## 触发与结果

`.github/workflows/dsh-compatibility.yml` 每天 **07:43 UTC** 检查一次，也支持手动执行：

- `version` 为精确官方版本（例如 `0.2.2-rc.4`，可带 `dsh-v` 前缀）；留空则分页调用 `deepseek-ai/deepseek-harness` 的 **List releases**，按 SemVer 选最高的已发布 RC/正式版。忽略草稿、未发布记录、其他产品、alpha/beta 和无效标签，不使用 `/latest`。
- 同一插件提交 SHA 下，已完成的 `Windows smoke (<版本>)` job 即为一次尝试；成功、失败和取消都计入，跳过不算。工作流并发组将选择和测试串行化，不依赖缓存标记或 artifact 的保留期。
- 已测试版本显示 `already-tested` 并跳过安装。手动勾选 `retry` 才重复尝试；新插件提交会重新测试。删除运行历史会丢失对应去重记录。
- 范围外的官方版本在选择阶段显示 **`needs-validation`** 并使工作流失败；记录上游版本、范围与插件 SHA，不安装、不激活、不写豁免、不修改范围、不发布版本。
- 下载、安装、激活或业务断言失败都是失败，不等同于兼容通过。Summary 和 artifact 保留选择和测试证据；详细结果可在仓库 Actions 的 **DSH Windows compatibility** 查看。

手动触发与每日定时使用同一逻辑；一次手动成功不代表 GitHub 的下一次定时已实际触发。

## Windows 测试内容

`scripts/ci/windows-smoke.ps1` 构建并用 `npm pack --offline --ignore-scripts` 产生安装包，在 `.cache/compatibility/<版本>/install-<包摘要>` 中安装该 tarball 和精确版本的官方 SDK。所有直接 DSH peers 也显式固定到目标版本，使用普通 npm peer 解析，不使用 `--force`、`--legacy-peer-deps` 或 DSH 版本豁免。

`scripts/ci/packed-smoke.mjs` 使用真实 boot/Loader、Tools、Typert、Session、LLM 及 AgentPresetRegistry 加载**安装后的包**，不直接调用源码的 apply：

1. 官方 profile 兼容预检接受包；逐项核对实际 peer 版本，防止 npm 静默选择别的宿主版本。
2. 插件和 UI RPC 激活；邮箱 Agent 经真实预设作用域加载，十组工具不泄露到全局。
3. 通过 UI 服务导入本地合成 MIME 邮件、搜索并读取正文，保存本地草稿。
4. 关闭并重启宿主，确认邮件和草稿持久化；验证打包的客户端模块入口。
5. 邮箱传输、真实凭据和模型均禁用；只创建本地归档账号，断言没有发送队列、发送预览、模型调用或联网尝试。

每次运行创建独立 `DSH_HOME` 和 `DSH_AGENTS_HOME`。运行阶段有出站网络防护；安装阶段从官方 npm registry 获取依赖。测试不读取真实邮件、项目或日常 DSH 配置，不安装到日用宿主，不发送邮件，不调用付费模型。

这是 Windows 上真实宿主服务的隔离集成测试，不能代替完整桌面容器、真实邮箱服务商、模型语义或所有界面组合的端到端验收。

## 固定环境与权限

- GitHub 托管 `windows-2022`，Node **24.21.0**，npm **11.12.1**；根目录依赖由提交的锁文件固定，SemVer **7.8.5**。
- checkout、setup-node 和 upload-artifact 固定到已核对的完整官方提交 SHA；checkout 不保存 Git 凭据。
- 工作流只有 `contents: read`、`actions: read`；smoke job 仅 `contents: read`。API token 只给选择步骤，无仓库写入、issue/PR、云模型或邮件密钥。
- SDK 直接依赖固定到所选官方 release 的精确版本。上游传递依赖按其声明正常解析，完整安装锁文件随 artifact 保存；这不声称是桌面安装包的逐字节镜像。
- artifact 保留 30 天，只上传 tarball、pack 清单、安装锁、选择/结果 JSON 和网络日志；不上传数据库、邮件或浏览器资料。

## 本地复现同包验证

```powershell
npm ci --ignore-scripts --no-audit --no-fund
./scripts/ci/windows-smoke.ps1 -Version 0.2.2-rc.2
./scripts/ci/windows-smoke.ps1 -Version 0.2.2-rc.3 -Archive .cache/compatibility/0.2.2-rc.2/dsh-mail-0.1.29.tgz
```

两个 `result.json` 的 `archiveSha256` 必须相同，且 `status` 都为 `passed`。`-Archive` 复用同一安装包，不重建；新摘要使用新安装目录以避免复用同版本旧包。脚本会替换本次进程的 `DSH_SDK_MODULES`，不修改原 SDK 或日常配置。
