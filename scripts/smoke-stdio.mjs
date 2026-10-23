// Starts `node dist/cli.js serve` with an empty data dir and drives it over stdio.
// Usage: node scripts/smoke-stdio.mjs <empty dir>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = process.argv[2];
const env = { ...process.env, TELEMCP_HOME: home };
delete env.TELEGRAM_API_ID;
delete env.TELEGRAM_API_HASH;
delete env.TELEMCP_BOT_TOKEN;
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/cli.js", "serve"], env, stderr: "inherit" });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);
console.log("instructions:", client.getInstructions());
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
for (const name of ["get_telegram_status", "get_usage", "list_accounts"]) {
  const r = await client.callTool({ name, arguments: {} });
  console.log(name, r.isError ? "(error)" : "", r.content[0].text);
}
const s = await client.callTool({ name: "send_message", arguments: { to: { telegram_username: "@someone" }, text: "hi" } });
console.log("send_message", s.isError ? "(error)" : "", s.content[0].text);
await client.close();
