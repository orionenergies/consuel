import express from 'express';

import { runJob, StepError } from './bot';
import { config } from './config';
import * as logger from './logger';
import { jobSchema } from './schema';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// Le compte Consuel est partagé : un seul run à la fois par instance
// (à combiner avec --concurrency=1 --max-instances=1 sur Cloud Run).
let busy = false;

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/run', async (req, res) => {
  const parsed = jobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      status: 'invalid_request',
      errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }

  if (busy) {
    res.set('Retry-After', '60').status(429).json({ status: 'busy', message: 'Un traitement est déjà en cours' });
    return;
  }

  busy = true;
  const job = parsed.data;
  logger.info('Run démarré', { plantCode: job.plantCode, projectType: job.projectType });
  try {
    const result = await runJob(job);
    logger.info('Run terminé', { plantCode: job.plantCode, status: result.status, durationMs: result.durationMs });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const step = err instanceof StepError ? err.step : 'inconnue';
    logger.error('Run en échec', { plantCode: job.plantCode, step, message });
    res.status(500).json({
      status: 'error',
      plantCode: job.plantCode,
      step,
      message,
      screenshotPath: err instanceof StepError ? err.screenshotPath : undefined,
      screenshotBase64: err instanceof StepError ? err.screenshotBase64 : undefined,
    });
  } finally {
    busy = false;
  }
});

const server = app.listen(config.port, () => {
  logger.info(`Serveur démarré sur le port ${config.port}`);
});

// Cloud Run envoie SIGTERM à l'arrêt de l'instance.
process.on('SIGTERM', () => {
  logger.info('SIGTERM reçu, arrêt du serveur');
  server.close(() => process.exit(0));
});
