export function conversationSubject(value) {
  let subject = String(value || "").normalize("NFC").replace(/\s+/g, " ").trim(), previous;
  do { previous = subject; subject = subject.replace(/^(?:re|回复|答复|返信)(?:\[\d+\])?\s*[:：]\s*/i, "").trim(); } while (previous !== subject);
  return subject.toLowerCase();
}

export function conversationHeaders(message) { return JSON.stringify([message.accountId, message.messageId, message.subject, message.references || [], message.inReplyTo || ""]); }

export function buildConversations(messages) {
  const parents = messages.map((_, i) => i), references = new Map(), byMessage = new Map(), groups = new Map();
  const root = (i) => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
  const ids = (value) => (Array.isArray(value) ? value : [value]).flatMap((part) => typeof part === "string" ? part.match(/<[^<>\s]+>/g) || [part.trim()] : []).filter(Boolean);
  for (const [i, message] of messages.entries()) {
    const subject = conversationSubject(message.subject);
    for (const reference of new Set([...ids(message.messageId), ...ids(message.references), ...ids(message.inReplyTo)])) {
      const key = JSON.stringify([message.accountId, subject, reference]), previous = references.get(key);
      if (previous === undefined) references.set(key, i); else { const a = root(i), b = root(previous); parents[Math.max(a, b)] = Math.min(a, b); }
    }
  }
  for (const [i, message] of messages.entries()) {
    const threadId = `conversation:${messages[root(i)].id}`;
    byMessage.set(message.id, threadId);
    if (!groups.has(threadId)) groups.set(threadId, []);
    groups.get(threadId).push(message.id);
  }
  return { byMessage, groups };
}
