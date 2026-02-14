import cors from 'cors';
import express from 'express';
import { APP_NAME, type ChatMessage } from '@curly-broccoli/shared';

type AppDependencies = {
  fetchRecentMessages: (limit?: number) => Promise<ChatMessage[]>;
};

export function createApp({ fetchRecentMessages }: AppDependencies) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'api' });
  });

  app.get('/messages', async (req, res) => {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

    const messages = await fetchRecentMessages(limit);
    res.json({ messages });
  });

  app.get('/', (_req, res) => {
    res.send(`${APP_NAME} API says hello.`);
  });

  return app;
}
