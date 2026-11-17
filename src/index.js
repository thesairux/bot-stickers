import { startBot } from './bot.js';

startBot().catch((err) => {
  console.error('[bot] Error fatal al iniciar:', err);
  process.exit(1);
});
