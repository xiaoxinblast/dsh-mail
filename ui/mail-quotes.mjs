import { isQuoteBoundary } from "../src/message-format.mjs";

const BLOCKS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "DT", "DD", "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "OL", "P", "PRE", "SECTION", "TABLE", "TR", "UL"]);
const NATIVE_QUOTES = "blockquote,.gmail_quote,.yahoo_quoted,[data-mail-quote]";

// Walk rendered line boundaries without replacing the email with plain text.
// Range cloning preserves links, inline formatting, tables and original order.
function markerLines(doc) {
  const lines = []; let text = "", start = null, end = null;
  const flush = () => { if (start && isQuoteBoundary(text)) lines.push({ text, start, end }); text = ""; start = end = null; };
  const walk = (node) => {
    if (node.nodeType === 3) {
      if (!node.parentElement.closest("pre,[style*='white-space: pre'],[style*='white-space:pre']")) {
        if (node.data) { start ||= { node, offset: 0 }; text += node.data.replace(/[\r\n\t]/g, " "); end = { node, offset: node.data.length }; }
        return;
      }
      let offset = 0;
      for (const part of node.data.split(/(\r?\n)/)) {
        if (/^\r?\n$/.test(part)) flush();
        else if (part) { start ||= { node, offset }; text += part; end = { node, offset: offset + part.length }; }
        offset += part.length;
      }
      return;
    }
    if (node.nodeType !== 1 || ["STYLE", "SCRIPT", "TEMPLATE"].includes(node.tagName)) return;
    if (node.tagName === "BR") { flush(); return; }
    const block = BLOCKS.has(node.tagName); if (block) flush();
    for (const child of node.childNodes) walk(child);
    if (block) flush();
  };
  walk(doc.body); flush(); return lines;
}
function fragment(doc, start, end) {
  const range = doc.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset); return range.cloneContents();
}
const bodyStart = (doc) => ({ node: doc.body, offset: 0 });
const bodyEnd = (doc) => ({ node: doc.body, offset: doc.body.childNodes.length });

export function splitReplyHtml(doc) {
  const marker = markerLines(doc)[0]; if (!marker) return null;
  const current = doc.createElement("div"), quoted = doc.createElement("div");
  current.append(fragment(doc, bodyStart(doc), marker.start)); quoted.append(fragment(doc, marker.start, bodyEnd(doc)));
  return { current: current.innerHTML, quoted: quoted.innerHTML };
}

export function decorateHtmlQuotes(doc) {
  const markers = markerLines(doc);
  if (markers.length) {
    const result = doc.createDocumentFragment(); result.append(fragment(doc, bodyStart(doc), markers[0].start));
    for (const [index, marker] of markers.entries()) {
      const section = doc.createElement("section"), heading = doc.createElement("header"), title = doc.createElement("strong"), source = doc.createElement("div"), body = doc.createElement("div");
      section.setAttribute("data-mail-history", "true"); section.setAttribute("aria-label", `引用邮件 ${index + 1}`);
      heading.className = "dm-quote-heading"; title.textContent = `引用邮件 · ${index + 1}`;
      source.className = "dm-quote-source"; source.append(fragment(doc, marker.start, marker.end)); heading.append(title, source);
      body.className = "dm-quote-body"; body.append(fragment(doc, marker.end, markers[index + 1]?.start || bodyEnd(doc)));
      // One clear generated title per section, including already marked input.
      for (const old of body.querySelectorAll("[data-mail-history]")) old.removeAttribute("data-mail-history");
      section.append(heading, body); result.append(section);
    }
    doc.body.replaceChildren(result);
  }
  for (const quote of doc.querySelectorAll(NATIVE_QUOTES)) {
    if (quote.closest("[data-mail-history]") || quote.parentElement.closest(NATIVE_QUOTES)) continue;
    quote.setAttribute("data-mail-history", "true");
    const heading = doc.createElement("header"); heading.className = "dm-quote-heading"; heading.textContent = "引用邮件"; quote.prepend(heading);
  }
}

export const QUOTE_FRAME_CSS = `
[data-mail-history]{display:block!important;border:1px solid #b8c1d3!important;border-left:4px solid #7c3aed!important;border-radius:8px!important;background:#f4f5fa!important;margin:28px 0!important;padding:0!important;overflow-wrap:anywhere;clear:both}
.dm-quote-heading{display:block!important;margin:0!important;padding:13px 16px!important;background:#ede9fe!important;border-bottom:1px solid #c4b5fd!important;color:#472178!important;font:600 14px/1.6 system-ui!important}
.dm-quote-heading strong{font:700 14px/1.6 system-ui!important;color:#472178!important}
.dm-quote-source{margin-top:4px!important;font:12px/1.65 system-ui!important;overflow-wrap:anywhere;color:#4b4562!important}
.dm-quote-source *{font:inherit!important;color:inherit!important;background:transparent!important}
.dm-quote-body{padding:4px 16px 14px!important;color:#30394c}
blockquote:not([data-mail-history]){border-left:2px solid #a8b2c5;margin:12px 0;padding-left:14px}
`;
