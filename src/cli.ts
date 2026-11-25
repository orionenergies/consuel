import { readFile } from 'node:fs/promises';

import { runJob, StepError } from './bot';
import { jobSchema } from './schema';

// Usage : npm run cli -- job.json   (ou JSON passé sur l'entrée standard)
async function main(): Promise<void> {
  const file = process.argv[2];
  const raw = file
    ? await readFile(file, 'utf8')
    : await new Promise<string>((resolve) => {
        let data = '';
        process.stdin.on('data', (c) => (data += c));
        process.stdin.on('end', () => resolve(data));
      });
  const job = jobSchema.parse(JSON.parse(raw));
  try {
    const result = await runJob(job);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (err instanceof StepError) {
      console.error(JSON.stringify({ status: 'error', step: err.step, message: err.message, screenshotPath: err.screenshotPath }, null, 2));
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  }
}

void main();
