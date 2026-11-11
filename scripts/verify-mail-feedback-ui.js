// Run with Playwright CLI run-code --filename after opening serve-mail-feedback-ui.mjs.
async (page) => {
  if (new URL(page.url()).hostname !== "127.0.0.1") throw new Error("Use only the local synthetic feedback fixture.");
  page.setDefaultTimeout(12000);
  const errors = [], checks = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const check = (value, message) => { if (!value) throw new Error(message); };
  const control = async (args = {}) => { const result = await (await page.request.post(new URL("/control", page.url()).href, { data: args })).json(); if (result.fixtureError) throw new Error(result.fixtureError); return result; };
  const refresh = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("dsh-mail:workbench", { detail: { sessionId: "feedback-ui" } })));
  const root = page.locator(".dsh-mail"), menu = page.getByRole("menu", { name: "邮件操作", exact: true });
  const subjects = ["十一月项目交付安排", "设计稿确认与下一步计划", "本周协作进度"];
  const row = (i) => root.locator(".dm-message-row").filter({ has: page.getByRole("heading", { name: `${subjects[i % 3]} ${i}`, exact: true }) });
  const openMenu = async (i) => { await row(i).locator("button.dm-message").click({ button: "right" }); await menu.waitFor(); };
  const item = (name) => menu.getByRole("menuitem", { name, exact: true });
  const shot = (name) => page.screenshot({ path: `output/playwright/mail-feedback/${name}.png` });
  const toast = (status) => root.locator(`.dm-send-toast[data-status="${status}"]`).last();
  const back = async () => { await root.getByRole("button", { name: "邮件", exact: true }).click(); await row(0).waitFor(); };
  await page.keyboard.press("Escape"); await page.setViewportSize({ width: 1440, height: 960 });
  await row(0).getByRole("checkbox").check();
  await openMenu(1);
  check(await root.locator(".dm-reader").count() === 0, "Right click opened the reader");
  check((await control()).messages.find((m) => m.id === "message-1").seen === false, "Right click marked mail read");
  await shot("context-light");
  await item("标为已读").click();
  await row(1).getByRole("button", { name: /^标为未读 / }).waitFor({ state: "attached" });
  let last = (await control()).requests.filter((r) => r.action === "messages.action").at(-1);
  check(JSON.stringify(last.ids) === '["message-1"]', "Context menu used the checkbox selection instead of its target");
  for (const label of ["标为未读", "添加星标", "取消星标"]) { await openMenu(1); await item(label).click(); await menu.waitFor({ state: "hidden" }); }
  await row(0).getByRole("checkbox").uncheck();
  checks.push("Right click preserves unread and reader state; read/star toggles affect only the clicked message even with another row checked.");

  await row(0).locator("button.dm-message").focus(); await page.keyboard.press("Shift+F10"); await menu.waitFor();
  check(await item("打开邮件").evaluate((el) => document.activeElement === el), "Menu did not focus its first action");
  await page.keyboard.press("End"); check(await item("删除").evaluate((el) => document.activeElement === el), "End key did not focus last item");
  await page.keyboard.press("ArrowDown"); check(await item("打开邮件").evaluate((el) => document.activeElement === el), "Arrow keys did not wrap");
  await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" });
  check(await row(0).locator("button.dm-message").evaluate((el) => document.activeElement === el), "Escape failed to restore row focus");
  await openMenu(0); await root.getByRole("heading", { name: "你的邮件工作台" }).click(); await menu.waitFor({ state: "hidden" });
  await openMenu(0); await root.locator(".dm-message-list").evaluate((el) => el.dispatchEvent(new Event("scroll"))); check(await menu.isVisible(), "A delayed scroll event closed a menu whose anchor had not moved");
  await root.locator(".dm-message-list").evaluate((el) => { el.scrollTop = 200; }); await menu.waitFor({ state: "hidden" });
  await openMenu(0); await page.keyboard.press("Tab"); await menu.waitFor({ state: "hidden" });
  checks.push("Shift+F10, arrow wrapping, End, Escape with focus restoration, Tab, outside click and list scroll dismissal work.");

  for (const label of ["回复", "回复全部", "转发"]) {
    await openMenu(0); await item(label).click(); const composer = root.locator(".dm-composer"); await composer.waitFor();
    const calls = (await control()).requests.filter((r) => r.action === "drafts.reply");
    check(calls.at(-1).id === "message-0", "Wrong reply source");
    const to = await composer.getByLabel("收件人", { exact: true }).inputValue();
    check(label === "转发" ? to === "" : to.includes("client@example.invalid"), "Wrong reply/forward recipients");
    await composer.getByRole("button", { name: "← 关闭", exact: true }).click();
  }
  await openMenu(0); await item("打开邮件").click(); await root.locator(".dm-reader").waitFor();
  await root.getByRole("button", { name: "返回邮件列表", exact: true }).click();
  checks.push("Open, reply, reply-all and forward use the clicked mail and existing composer.");

  for (const mode of ["复制邮件", "移动邮件"]) {
    await openMenu(2); await item("移动／复制到文件夹…").click(); const dialog = root.getByRole("dialog");
    if (mode === "移动邮件") await dialog.getByRole("radio", { name: "移动，离开原位置", exact: true }).check();
    await dialog.getByLabel("目标文件夹", { exact: true }).selectOption(mode === "复制邮件" ? "projects" : "archive");
    await dialog.getByRole("button", { name: mode, exact: true }).click(); await dialog.waitFor({ state: "hidden" });
    const exists = (await control()).messages.some((m) => m.id === "message-2");
    check(exists === (mode === "复制邮件"), "Copy/move did not preserve/remove the source as requested");
  }
  for (const [i, label, operation] of [[3, "归档", "archive"], [4, "移到垃圾邮件", "junk"], [5, "删除", "trash"]]) {
    await openMenu(i); await item(label).click(); await row(i).waitFor({ state: "hidden" });
    last = (await control()).requests.filter((r) => r.action === "messages.action").at(-1);
    check(last.operation === operation && last.ids[0] === `message-${i}`, `Wrong ${operation} target`);
  }
  checks.push("Actual MailService jobs complete copy, move, archive, junk and trash operations on the intended mail.");

  for (const theme of ["light", "dark"]) {
    await control({ settings: { theme } }); await refresh();
    await page.waitForFunction((theme) => document.querySelector(".dm-app").dataset.theme === theme, theme);
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 540 : 900 });
      await row(17).scrollIntoViewIfNeeded(); await row(17).click({ button: "right", position: { x: (await row(17).boundingBox()).width - 4, y: 70 } }); await menu.waitFor();
      const b = await menu.boundingBox(); check(b.x >= 0 && b.y >= 0 && b.x + b.width <= width + 1 && b.y + b.height <= (width === 390 ? 540 : 900) + 1, "Menu overflowed viewport");
      check(await root.evaluate((el) => el.scrollWidth <= el.clientWidth), "Menu caused horizontal overflow");
      await shot(`context-${theme}-${width}`); await page.keyboard.press("Escape");
    }
  }
  checks.push("Light/dark screenshots and 1440/768/390 px lower-right edge placement stay within the viewport.");

  await page.setViewportSize({ width: 1440, height: 960 }); await back();
  const compose = async (subject, reply = false) => {
    if (reply) { await openMenu(0); await item("回复").click(); } else await root.getByRole("button", { name: "写邮件", exact: true }).click();
    const composer = root.locator(".dm-composer"); await composer.waitFor();
    if (!reply) await composer.getByLabel("收件人", { exact: true }).fill("client@example.invalid");
    await composer.getByLabel("主题", { exact: true }).fill(subject); await composer.locator(".tiptap").fill("这是隔离环境的发送气泡验收。");
    return composer;
  };
  const confirm = async (composer) => { await composer.getByRole("button", { name: "预览并发送 →", exact: true }).click(); await root.getByRole("dialog").getByRole("button", { name: "确认发送", exact: true }).click(); await toast("queued").waitFor(); };
  await confirm(await compose("发送验收：取消")); await shot("queued-dark");
  await toast("queued").getByRole("button", { name: "取消发送", exact: true }).click(); await toast("cancelled").waitFor();
  check((await control()).sending === 0, "Cancelling a queued mail reached SMTP");
  await toast("cancelled").waitFor({ state: "hidden" });
  checks.push("Confirming a send shows a queued toast; cancelling preserves the draft and never calls SMTP.");

  for (const [result, reply] of [["sent", false], ["failed", true], ["uncertain", false]]) {
    await confirm(await compose(`发送验收：${result}`, reply));
    await root.getByRole("button", { name: "待办", exact: true }).click();
    await control({ advance: 11000 }); await toast("sending").waitFor();
    check(await toast("sending").getByRole("button", { name: "取消发送", exact: true }).count() === 0, "Sending incorrectly allows cancellation");
    await shot(`sending-${result}`);
    await control({ finish: result }); await toast(result).waitFor(); await shot(`result-${result}`);
    if (result === "sent") await toast(result).waitFor({ state: "hidden" });
    else {
      await page.waitForTimeout(4700); check(await toast(result).isVisible(), "Error toast auto-dismissed");
      await toast(result).getByRole("button", { name: "查看详情", exact: true }).click(); await root.locator(".dm-composer").waitFor();
      check(await root.locator(".dm-composer").innerText().then((s) => s.includes(result === "failed" ? "测试服务器拒绝发送" : "测试连接中断")), "Detail did not open the affected draft");
      await toast(result).getByRole("button", { name: /^关闭发送提示/ }).click();
    }
    await back();
  }
  checks.push("New mail and replies retain sending feedback across page switches; success expires, failure/unknown remain and open the affected draft.");

  await control({ settings: { theme: "light" } }); await refresh();
  const scheduled = await compose("发送验收：定时发送");
  await scheduled.getByLabel("发送选项", { exact: true }).click();
  await scheduled.getByLabel("发送方式", { exact: true }).selectOption("scheduled");
  await scheduled.getByLabel("计划发送时间", { exact: true }).fill("2099-11-13T10:30");
  await page.keyboard.press("Escape"); await confirm(scheduled);
  check(await toast("queued").innerText().then((s) => s.includes("2099") && s.includes("计划发送")), "Scheduled toast did not display the actual schedule");
  await shot("scheduled-light"); await page.setViewportSize({ width: 390, height: 700 }); await shot("scheduled-light-390");
  const bounds = await toast("queued").boundingBox(), rail = await root.getByRole("navigation", { name: "功能导航" }).boundingBox(); check(bounds.x >= rail.x + rail.width && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 700, "Toast overflowed narrow viewport or covered navigation");
  await toast("queued").getByRole("button", { name: "取消发送", exact: true }).click();
  checks.push("Scheduled confirmation shows its planned time; narrow-screen toast stays within bounds and supports cancellation.");
  check(errors.length === 0, JSON.stringify(errors));
  return { checks, errors };
}
