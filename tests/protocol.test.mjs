import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { SMTPServer } from "smtp-server";
import { MailTransport, composeDraft } from "../src/mail.mjs";

const raw = Buffer.from("From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: test fixture\r\n\r\nLocal protocol fixture only.\r\n");
test("real ImapFlow wire roundtrip; UID-safe source fetch, flags, COPYUID, UID EXPUNGE", async (t) => {
  const commands = [], sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.write("* OK [CAPABILITY IMAP4rev1 ID AUTH=PLAIN UIDPLUS] fixture\r\n"); let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes("\r\n")) {
        const i = buffer.indexOf("\r\n"), line = buffer.slice(0, i); buffer = buffer.slice(i + 2); const [tag, command, ...rest] = line.split(" "); const args = rest.join(" "); commands.push(command + (command === "UID" ? " " + rest[0] : ""));
        if (command === "CAPABILITY") socket.write("* CAPABILITY IMAP4rev1 ID AUTH=PLAIN UIDPLUS\r\n");
        else if (command === "ID") socket.write('* ID ("name" "fixture")\r\n');
        else if (command === "AUTHENTICATE" || command === "LOGIN" || command === "NOOP") {}
        else if (command === "LIST") socket.write('* LIST (\\Inbox) "/" "INBOX"\r\n');
        else if (command === "LSUB") socket.write('* LSUB (\\Inbox) "/" "INBOX"\r\n');
        else if (["SELECT", "EXAMINE"].includes(command)) socket.write("* FLAGS (\\Seen \\Flagged \\Deleted)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 7] stable\r\n* OK [UIDNEXT 2] next\r\n");
        else if (command === "UID" && rest[0] === "FETCH") { socket.write(`* 1 FETCH (UID 1 BODY[] {${raw.length}}\r\n`); socket.write(raw); socket.write(")\r\n"); }
        else if (command === "UID" && rest[0] === "STORE") socket.write("* 1 FETCH (UID 1 FLAGS (\\Seen))\r\n");
        else if (command === "UID" && rest[0] === "COPY") { socket.write(`${tag} OK [COPYUID 8 1 12] copied\r\n`); continue; }
        else if (command === "UID" && rest[0] === "EXPUNGE") socket.write("* 1 EXPUNGE\r\n");
        else if (command === "LOGOUT") { socket.end(`* BYE\r\n${tag} OK bye\r\n`); continue; }
        else { socket.write(`${tag} BAD unsupported fixture command ${command} ${args}\r\n`); continue; }
        socket.write(`${tag} OK completed\r\n`);
      }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  // Plaintext is restricted to this loopback fixture. Production MailTransport requires TLS.
  const client = new ImapFlow({ host: "127.0.0.1", port: server.address().port, secure: false, doSTARTTLS: false, auth: { user: "fixture", pass: "fixture-only" }, logger: false, disableAutoIdle: true, clientInfo: { name: "DSH Mail fixture", version: "test" } });
  client.on("error", () => {}); t.after(() => client.close()); await client.connect();
  const transport = new MailTransport({ getPassword: async () => "unused" }); transport.clients.set("a", client);
  const account = { id: "a" }, folder = { path: "INBOX" }, message = { uid: 1, uidValidity: "7", size: raw.length };
  assert.deepEqual(await transport.raw(account, folder, message), raw);
  await assert.rejects(transport.raw(account, folder, { ...message, uidValidity: "6" }), { code: "UIDVALIDITY_CHANGED" });
  await transport.flags(account, folder, message, ["\\Seen"], []);
  const copied = await transport.copy(account, folder, message, { path: "Target" }); assert.equal(copied.uidMap.get(1), 12); assert.equal(copied.uidValidity, 8n);
  await transport.purge(account, folder, message); assert.ok(commands.includes("UID EXPUNGE")); assert.ok(!commands.includes("EXPUNGE")); assert.ok(commands.includes("ID"));
  client.capabilities.delete("UIDPLUS"); const before = commands.length; await assert.rejects(transport.purge(account, folder, message), { code: "UNSAFE_EXPUNGE" }); assert.equal(commands.length, before);
  await transport.close();
});

test("real Nodemailer SMTP transaction preserves raw MIME and reports accepted recipients", async (t) => {
  const received = [];
  const server = new SMTPServer({ disabledCommands: ["STARTTLS"], authOptional: true, logger: false, onData(stream, session, done) { const chunks = []; stream.on("data", (c) => chunks.push(c)); stream.on("end", () => { received.push({ raw: Buffer.concat(chunks), to: session.envelope.rcptTo }); done(null, "fixture accepted"); }); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  const transport = new MailTransport({ getPassword: async () => "fixture-only" });
  transport.smtp = () => nodemailer.createTransport({ host: "127.0.0.1", port: server.server.address().port, secure: false, ignoreTLS: true });
  const account = { email: "sender@example.com", name: "Fixture", id: "a" }, compiled = await composeDraft({ to: "recipient@example.com", subject: "协议联调", text: "测试内容" }, account, () => {});
  const result = await transport.send(account, compiled.raw, compiled.envelope); assert.deepEqual(result.accepted, ["recipient@example.com"]); assert.equal(received.length, 1); assert.equal(received[0].to[0].address, "recipient@example.com"); assert.ok(received[0].raw.includes(Buffer.from(compiled.messageId))); await transport.close();
});
