import { spawn } from "node:child_process";
import { join } from "node:path";
import { requireValue } from "./util.mjs";

// Only ciphertext is persisted. Secrets travel over private stdin/stdout, never argv.
export class WindowsVault {
  async transform(mode, value) {
    requireValue(process.platform === "win32", "VAULT_UNAVAILABLE", "本版本的凭据保护需要 Windows DPAPI。");
    const script = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[Security.Cryptography.ProtectedData]::${mode}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
    return new Promise((resolve, reject) => {
      const child = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const chunks = []; child.stdout.on("data", (x) => chunks.push(x)); child.stderr.resume();
      const timer = setTimeout(() => { child.kill(); reject(new Error("凭据保护超时")); }, 15000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve(Buffer.from(Buffer.concat(chunks).toString().trim(), "base64")) : reject(new Error("无法访问 Windows 凭据保护，请使用原 Windows 用户重新连接账号。")); });
      child.stdin.end(Buffer.from(value).toString("base64"));
    });
  }
  async seal(value) { return (await this.transform("Protect", Buffer.from(value, "utf8"))).toString("base64"); }
  async open(value) { return (await this.transform("Unprotect", Buffer.from(value, "base64"))).toString("utf8"); }
}
