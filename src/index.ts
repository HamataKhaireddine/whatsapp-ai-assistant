import { loadConfig, loadDotEnv } from "./config.js";
import { createApp } from "./app.js";
import { createHttpServer } from "./server.js";

loadDotEnv();
const config = loadConfig();
const app = createApp({ config, persistAppointments: true });
const server = createHttpServer(app);

server.listen(config.port, () => {
  console.info(`🐾 ${config.businessName} assistant running on http://localhost:${config.port}`);
  console.info(`   LLM:      ${app.llm.name}${config.llm.provider === "mock" ? "  (offline mock - set OPENAI_API_KEY for a real model)" : ` @ ${config.llm.baseUrl}`}`);
  console.info(`   WhatsApp: ${config.whatsapp.accessToken ? "Cloud API" : "mock (replies are logged, not sent)"} - webhook at /webhook`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
