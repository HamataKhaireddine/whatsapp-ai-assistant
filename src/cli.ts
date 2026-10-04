import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { loadConfig, loadDotEnv } from "./config.js";
import { createApp } from "./app.js";

/** Local REPL - chat with the assistant in your terminal. No server, no WhatsApp needed. */
loadDotEnv();
const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
const config = loadConfig();
const quiet = { info: () => {}, warn: console.warn, error: console.error };
const app = createApp({ config, logger: verbose ? console : quiet });
const dim = (s: string) => (stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const session = { customerId: "cli-user", channel: "cli" as const };

console.log(`\n🐾 ${config.businessName} - assistant (${app.llm.name})`);
console.log('Try: "dog food under $30", "tell me about P010", "book a grooming tomorrow". Commands: /reset, /exit\n');

const rl = createInterface({ input: stdin, output: stdout, prompt: "you > " });
rl.prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (line === "/exit" || line === "/quit") break;
  if (line === "/reset") {
    app.assistant.sessions.reset(session.customerId);
    console.log("(conversation cleared)\n");
  } else if (line) {
    if (!stdin.isTTY) console.log(line); // echo when input is piped, so transcripts read naturally
    const { reply, toolCalls } = await app.assistant.handleMessage(line, session);
    for (const t of toolCalls) console.log(dim(`  ⚙ ${t.name}(${JSON.stringify(t.args)})${t.ok ? "" : " ✗"}`));
    console.log(`bot > ${reply.replace(/\n/g, "\n      ")}\n`);
  }
  rl.prompt();
}
rl.close();
