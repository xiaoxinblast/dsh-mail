# 邮件工作区全屏

DSH Mail 0.1.20 支持在原有视图与工作区全屏之间切换。工作区全屏覆盖 DSH 默认左侧栏及会话区域，保留系统标题栏和窗口控制；它不会创建浮动面板或独立系统窗口。

- 点击邮件右上角的“全屏显示邮件”进入全屏。打开 AI 助手后，助手标题栏也提供切换入口。
- 从会话右侧栏进入时，点击“收回侧栏”返回原侧栏的宽度与位置；从全局主面板进入时，“退出全屏”返回该主面板。
- 没有其他菜单或对话框时，Escape 返回原视图；已有菜单或对话框优先处理 Escape。
- 切换沿用同一个邮件根节点、正文 iframe、草稿编辑器与原生 AI 对话，不重新创建邮件页面。当前邮件、编辑内容、输入选择和滚动位置保持。
- 视图过渡为 180 毫秒。系统启用减少动态效果时不启动该过渡；不支持 View Transition 的浏览器使用短淡入作为兼容路径。

邮件界面保持宿主的深浅主题，窄尺寸下标题、时间和操作区自动排布，返回入口保持可用。AI 侧栏调宽及邮件发送前的人工确认流程保持原有功能。

## 实现边界

插件通过公开的 `shell.overlay` 席位加载全局呈现样式，并让已连接的邮件根 `dialog` 使用浏览器标准顶层呈现。进入全屏不移动 iframe 或编辑器节点，退出时回到原 DOM 位置。Windows 使用宿主公开的 `--dsh-frame-chrome-top` 保留原生顶栏高度。没有修改 DSH 安装程序或放宽窗口、凭据及原生 IPC 权限。

## 更新与验证

需要更新 DSH Mail 到 0.1.20，并按插件管理器提示重新载入或重启；无需更新或修改 DSH 宿主。源码构建产物是 `dist/client.js`，可用 `npm pack` 生成本地插件包。本轮交付未安装到日常 profile，也未推送或部署。

基础检查使用 `npm test`、`npm run build`、`npm run check` 与 `git diff --check`。

界面回归使用 `scripts/fixtures/assistant-model.mjs` 对应的仓库隔离 Host 和合成邮件，打开测试会话的邮件侧栏后，通过 Playwright CLI 执行：

```powershell
npx --package @playwright/cli playwright-cli -s=mail-check run-code --filename scripts/verify-workspace-fullscreen-ui.js
```

该脚本应只运行在隔离回环地址；覆盖四边与左侧栏遮挡、同一正文和编辑器、滚动与光标、原生 AI 对话、180 毫秒过渡、减少动态效果、窄尺寸及 Windows 顶栏条件。截图写入 `output/playwright/`。不执行发送确认。
