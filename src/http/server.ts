import { z } from 'zod';
import { buildApp } from './app.js';
import { connectDatabase } from '../storage/database.js';

const config = z
  .object({
    DATABASE_URL: z.string().min(1),
    STEWARD_API_TOKEN: z.string().min(32),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  })
  .parse(process.env);

const db = connectDatabase(config.DATABASE_URL);
const app = buildApp(db, config.STEWARD_API_TOKEN, true);
app.addHook('onClose', async () => {
  await db.destroy();
});

async function shutdown() {
  try {
    await app.close();
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});

try {
  await app.listen({ host: '127.0.0.1', port: config.PORT });
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
