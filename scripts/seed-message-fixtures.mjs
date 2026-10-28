// Synthetic messages and events only, inside the repository's isolated profile.
import { fileURLToPath } from "node:url";
import { MailService } from "../src/service.mjs";
import { composeDraft } from "../src/mail.mjs";
import { DateTime } from "luxon";
const service = new MailService({ directory: fileURLToPath(new URL("../.cache/dsh-home/dsh-mail/web", import.meta.url)), transport: { close: async () => {} } });
try {
  if (!service.store.get("settings", "message-ui-seeded")) {
    const image = await service.upload({ filename: "pixel.png", contentType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=" });
    const compiled = await composeDraft({ to: "demo@example.invalid", subject: "[验收] 文件夹位置与图片加载", text: "这是一封合成邮件，用于文件夹和图片加载验收。", html: '<h2>项目交付确认</h2><p>此内容仅用于本机验收。</p><img alt="内嵌图片" src="cid:fixture-inline"><img alt="外部图片" src="https://mail-image.example.invalid/sample.png">', attachments: [{ id: image.id, cid: "fixture-inline" }] }, { email: "client@example.invalid", name: "项目团队" }, (id) => service.ensureAttachment(id));
    const imported = await service.importMail({ base64: compiled.raw.toString("base64"), folderName: "[验收] 收件箱" });
    const folder = service.folder(imported.folderId); service.store.put("folders", { ...folder, role: "\\Inbox", count: 1, color: "#2563eb" });
    for (const [path, color] of [["[验收] 项目 A", "#15803d"], ["[验收] 项目 B", "#d97706"]]) { const target = await service.folderOperation({ operation: "create", accountId: "local", path }, { kind: "human" }); service.store.put("folders", { ...target, color }); }
    service.store.put("settings", { id: "message-ui-seeded", messageId: imported.ids[0] });
  }
  const fixture = service.message(service.store.get("settings", "message-ui-seeded").messageId), source = service.store.list("folders").find((folder) => folder.accountId === "local" && folder.path === "[验收] 收件箱");
  if (fixture.accountId !== "local" || fixture.subject !== "[验收] 文件夹位置与图片加载" || !source) throw new Error("Synthetic fixture identity changed; refusing to reset it.");
  for (const location of service.store.messageLocations(fixture)) if (location.id !== fixture.id) service.store.deleteMessage(location.id);
  if (fixture.folderId !== source.id) await service.messageAction(fixture.id, { operation: "move", destinationId: source.id });
  for (const event of service.store.list("events")) if (event.title === "[验收] 新事件正常色") service.store.remove("events", event.id);
  const today = DateTime.now().setZone("Asia/Hong_Kong").startOf("day"), current = { color: "#22dbf4", allDay: true, timeZone: "Asia/Hong_Kong" };
  for (const event of [
    { ...current, id: "display-ended", title: "已结束 · 项目交付", start: today.minus({ days: 5 }).toISODate(), end: today.minus({ days: 1 }).toISODate() },
    { ...current, id: "display-active", title: "进行中 · 本周翻译交付", start: today.minus({ days: 1 }).toISODate(), end: today.plus({ days: 3 }).toISODate() },
    { ...current, id: "display-next", color: "#ffb878", title: "待开始 · 下一批次", start: today.plus({ days: 4 }).toISODate(), end: today.plus({ days: 7 }).toISODate() },
    { ...current, id: "display-green", color: "#7ae8c0", title: "项目资料整理", start: today.plus({ days: 1 }).toISODate(), end: today.plus({ days: 5 }).toISODate() },
    { ...current, id: "display-inherited", color: undefined, title: "[验收] 跟随日历颜色", start: today.toISODate(), end: today.plus({ days: 1 }).toISODate() },
  ]) service.saveEvent(event);
  service.store.put("settings", { ...service.settings(), id: "general", calendarView: "dayGridMonth", calendarTimeZone: "Asia/Hong_Kong", firstDay: 1, markReadOnOpen: false, loadRemoteImages: false });
  console.log("Synthetic message locations, inline/external images and ended/active calendar events ready.");
} finally { await service.close(); }
