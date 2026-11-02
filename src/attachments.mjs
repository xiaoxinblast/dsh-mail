// MIME resources remain available to the HTML renderer; only downloads are listed.
export function downloadableAttachments(message) {
  const parts = new Map();
  const visit = (node) => { if (!node) return; if (!node.type?.startsWith("multipart/")) parts.set(node.part || "1", node); if (node.type !== "message/rfc822") for (const child of node.childNodes || []) visit(child); };
  visit(message.bodyStructure);
  return (message.attachments || []).filter((attachment) => {
    const node = attachment.part ? parts.get(attachment.part) : null;
    if (message.bodyStructure && attachment.part && !node) return false;
    const type = (node?.type || attachment.contentType || "").toLowerCase();
    if (type.startsWith("multipart/")) return false;
    if (node && ["text/html", "text/plain"].includes(type) && node.disposition !== "attachment" && !node.dispositionParameters?.filename && !node.parameters?.name) return false;
    const disposition = node ? node.disposition : attachment.disposition;
    const cid = attachment.cid || node?.id?.replace(/^<|>$/g, "");
    return !(type.startsWith("image/") && cid && disposition !== "attachment" && (disposition === "inline" || node || message.html?.includes(`cid:${cid}`)));
  });
}
