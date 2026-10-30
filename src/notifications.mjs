import { spawn } from "node:child_process";
import { join } from "node:path";
import { requireValue } from "./util.mjs";

export const DSH_APP_ID = "electron.app.DeepSeek Harness";

export function toastXml(notification) {
  const escape = (value) => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
  return `<toast><visual><binding template="ToastGeneric"><text>DSH Mail</text><text>${escape(notification.title)}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default" /></toast>`;
}

// Fixed script; mail text is XML-escaped and passed as UTF-8/base64 over stdin, never executed.
export async function sendWindowsNotification(notification) {
  requireValue(process.platform === "win32", "NOTIFICATIONS_UNAVAILABLE", "系统通知需要 Windows。");
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $dshApplication=Get-StartApps | Where-Object { $_.AppID -eq '${DSH_APP_ID}' } | Select-Object -First 1; if($null -eq $dshApplication){throw 'DSH 未在 Windows 开始菜单注册，无法显示系统通知。'}; [Windows.UI.Notifications.ToastNotifier,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null; [Windows.UI.Notifications.NotificationSetting,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null; [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null; [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] > $null; $xml=New-Object Windows.Data.Xml.Dom.XmlDocument; $xml.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))); $notifier=[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($dshApplication.AppID); if($notifier.get_Setting().ToString() -ne 'Enabled'){throw ('Windows notifications: '+$notifier.get_Setting().ToString())}; $toast=[Windows.UI.Notifications.ToastNotification]::new($xml); $toast.ExpirationTime=[DateTimeOffset]::Now.AddMinutes(5); $notifier.Show($toast); [Console]::Out.Write('submitted')`;
  return new Promise((resolve, reject) => {
    const child = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const output = [], errors = [];
    child.stdout.on("data", (data) => output.push(data)); child.stderr.on("data", (data) => errors.push(data));
    const timer = setTimeout(() => { child.kill(); reject(new Error("Windows 系统通知超时，请检查通知设置。")); }, 15000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdin.on("error", () => {});
    child.once("close", (code) => { clearTimeout(timer); code === 0 && Buffer.concat(output).toString().trim() === "submitted" ? resolve({ status: "submitted" }) : reject(new Error(`Windows 系统通知未提交：${Buffer.concat(errors).toString().trim().slice(0, 500) || code}`)); });
    child.stdin.end(Buffer.from(toastXml(notification), "utf8").toString("base64"));
  });
}
