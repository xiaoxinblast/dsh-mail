// Synthetic fixtures only, in the repository-local isolated profile.
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { MailService } from "../src/service.mjs";
import { composeDraft } from "../src/mail.mjs";

function landscape() {
  const width = 320, height = 180, pixels = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const mountain = y > 155 - Math.abs(x - 110) * .6 || y > 145 - Math.abs(x - 255) * .5, sun = (x - 250) ** 2 + (y - 42) ** 2 < 18 ** 2; const color = sun ? [255, 206, 96] : mountain ? [38, 125 + Math.floor(y / 10), 112] : [120 + Math.floor(y / 3), 192 + Math.floor(y / 6), 240]; const offset = y * (width * 3 + 1) + 1 + x * 3; pixels.set(color, offset); }
  const crc = (bytes) => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

const service = new MailService({ directory: fileURLToPath(new URL("../.cache/dsh-home/dsh-mail/web", import.meta.url)), transport: { close: async () => {} } });
try {
  const existing = service.store.get("settings", "reading-ui-seeded");
  if (existing) { console.log("Reading fixtures already seeded."); } else {
    const image = await service.upload({ filename: "山景示意图.png", contentType: "image/png", base64: landscape().toString("base64") });
    const word = new JSZip(); word.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'); word.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic document</w:t></w:r></w:p></w:body></w:document>');
    const documents = [];
    for (const [filename, contentType, bytes] of [["项目交付说明.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", await word.generateAsync({ type: "nodebuffer" })], ["报价与交付计划.pdf", "application/pdf", Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF")], ["项目数据.csv", "text/csv", Buffer.from("project,status\nfixture,ready\n")], ["项目资源.zip", "application/zip", await new JSZip().file("notes.txt", "Synthetic resource").generateAsync({ type: "nodebuffer" })]]) documents.push(await service.upload({ filename, contentType, base64: bytes.toString("base64") }));
    const account = { email: "team@example.invalid", name: "项目团队" }, ids = {};
    const save = async (name, html, attachments, text = "用于本机阅读与附件验收的合成邮件。") => {
      const compiled = await composeDraft({ to: "reader@example.invalid", subject: `[验收] ${name}`, text, html, attachments }, account, (id) => service.ensureAttachment(id));
      const imported = await service.importMail({ base64: compiled.raw.toString("base64"), folderName: "[验收] 阅读与附件" });
      const folder = service.folder(imported.folderId); service.store.put("folders", { ...folder, role: "\\Inbox" }); ids[name] = imported.ids[0]; return service.message(imported.ids[0]);
    };
    const inline = await save("无附件的共享通知", '<div style="background:#f3f5f8;padding:32px;text-align:center"><h1>项目资料已共享</h1><p>项目团队邀请你查看交付资料</p><h2>十一月项目资料</h2><p>此邮件仅包含正文图片，没有可下载的文件附件。</p>' + [1, 2, 3, 4].map((i) => `<img width="${i === 1 ? 320 : 24}" src="cid:inline-${i}" alt="正文图片 ${i}">`).join("") + '</div>', [1, 2, 3, 4].map((i) => ({ id: image.id, cid: `inline-${i}` })));
    const resources = inline.attachments.map((a, i) => ({ ...a, part: String(i + 2) }));
    service.store.upsertMessage({ ...inline, attachments: [{ id: "synthetic-phantom-body", part: "1.2", contentType: "text/html", filename: "attachment", disposition: "attachment", cid: "body", size: 24014 }, ...resources], bodyStructure: { type: "multipart/related", childNodes: [{ type: "multipart/alternative", part: "1", childNodes: [{ type: "text/plain", part: "1.1" }, { type: "text/html", part: "1.2", id: "<body>" }] }, ...resources.map((a) => ({ type: a.contentType, part: a.part, id: `<${a.cid}>`, disposition: "inline" }))] } });
    await save("附件缩略图与文档类型", '<h1>项目交付资料</h1><p>请核对下面的图片、Word、PDF、表格和压缩文件。</p><p>图片卡片展示附件实际内容，文档卡片展示文件类型。</p><img src="cid:signature" width="28" alt="内嵌签名">', [...documents.map((a) => ({ id: a.id })), { id: image.id }, { id: image.id, cid: "signature" }]);
    await save("长邮件正文阅读", '<h1>十一月项目交付计划</h1>' + Array.from({ length: 35 }, (_, i) => `<h2>第 ${i + 1} 项交付安排</h2><p>这是用于验证正文高度和滚动阅读的合成内容。请核对交付日期、资料完整性与质量检查结果。</p>`).join(""), []);
    await save("纯文本阅读", "", [], "纯文本邮件也应正常显示。\n项目说明：https://example.invalid/project\n" + "合成阅读内容。\n".repeat(30));
    service.store.put("settings", { id: "reading-ui-seeded", ids });
    console.log("Reading, legacy phantom attachments and real image/document thumbnail fixtures ready.");
  }
  if (!service.store.get("settings", "reading-ui-failure-seeded")) {
    const broken = await service.upload({ filename: "无法解码的图片.png", contentType: "image/png", base64: Buffer.from("Synthetic invalid image bytes").toString("base64") }), unknown = await service.upload({ filename: "项目交付资料_需要保留完整名称的附件_十一月第一批_术语与质量检查结果_最终确认版本.custom", contentType: "application/octet-stream", base64: Buffer.from("Synthetic unknown document type").toString("base64") });
    const compiled = await composeDraft({ to: "reader@example.invalid", subject: "[验收] 附件异常与长文件名", text: "用于验证损坏图片与长文件名。", html: "<h2>附件回退显示</h2><p>图片无法解码时仍可预览或下载，长文件名可换行。</p>", attachments: [{ id: broken.id }, { id: unknown.id }] }, { email: "team@example.invalid", name: "项目团队" }, (id) => service.ensureAttachment(id));
    const imported = await service.importMail({ base64: compiled.raw.toString("base64"), folderName: "[验收] 阅读与附件" });
    service.store.put("settings", { id: "reading-ui-failure-seeded", messageId: imported.ids[0] });
  }
} finally { await service.close(); }
