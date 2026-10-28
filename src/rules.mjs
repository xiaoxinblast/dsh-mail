import { requireValue } from "./util.mjs";

const FIELDS = new Set(["from", "to", "subject", "text", "hasAttachment", "seen", "starred"]);
const ACTIONS = new Set(["star", "read", "label", "move", "archive", "task"]);
export function validateRule(rule) {
  requireValue(rule.name?.trim(), "RULE_NAME_REQUIRED", "请填写规则名称。");
  requireValue(Array.isArray(rule.conditions) && rule.conditions.length > 0 && rule.conditions.length <= 20, "RULE_CONDITIONS", "规则需要 1–20 个条件。");
  requireValue(Array.isArray(rule.actions) && rule.actions.length > 0 && rule.actions.length <= 10, "RULE_ACTIONS", "规则需要 1–10 个动作。");
  for (const c of rule.conditions) requireValue(FIELDS.has(c.field) && ["contains", "equals", "notContains", "endsWith"].includes(c.operator), "INVALID_RULE_CONDITION", "规则包含不支持的条件。");
  for (const a of rule.actions) requireValue(ACTIONS.has(a.action), "RULE_ACTION_FORBIDDEN", "后台规则仅允许星标、已读、本地标签、移动、归档和本地待办。");
  return { ...rule, match: rule.match === "any" ? "any" : "all", priority: Number(rule.priority || 0), enabled: !!rule.enabled };
}
export function matches(rule, message) {
  if (rule.accountId && rule.accountId !== message.accountId) return false;
  const test = (c) => {
    const raw = c.field === "hasAttachment" ? !!message.attachments?.length : message[c.field];
    const value = (Array.isArray(raw) ? raw.map((x) => x.address || x).join(" ") : String(raw ?? "")).toLowerCase();
    const needle = String(c.value).toLowerCase();
    return c.operator === "equals" ? value === needle : c.operator === "notContains" ? !value.includes(needle) : c.operator === "endsWith" ? value.endsWith(needle) : value.includes(needle);
  };
  return rule.match === "any" ? rule.conditions.some(test) : rule.conditions.every(test);
}
