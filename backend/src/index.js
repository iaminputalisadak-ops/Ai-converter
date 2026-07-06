import express from 'express';
import cors from 'cors';
import { config, ensureDirectories } from './config.js';
import videoRoutes from './routes/video.js';

const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

app.use('/api/video', videoRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

await ensureDirectories();

app.listen(config.port, () => {
  console.log(`Converter API running on http://localhost:${config.port}`);
});
