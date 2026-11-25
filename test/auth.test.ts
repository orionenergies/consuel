import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response } from 'express';

import { apiKeyAuth } from '../src/auth';

function run(opts: { apiKey: string; production: boolean }, headerKey?: string) {
  let status = 0;
  let nexted = false;
  const req = { header: (n: string) => (n === 'x-api-key' ? headerKey : undefined) } as unknown as Request;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  apiKeyAuth(opts)(req, res, () => {
    nexted = true;
  });
  return { status, nexted };
}

test('production : clé valide acceptée', () => {
  assert.deepEqual(run({ apiKey: 'secret', production: true }, 'secret'), { status: 0, nexted: true });
});

test('production : clé absente → 401', () => {
  assert.deepEqual(run({ apiKey: 'secret', production: true }), { status: 401, nexted: false });
});

test('production : clé invalide → 403', () => {
  assert.deepEqual(run({ apiKey: 'secret', production: true }, 'autre'), { status: 403, nexted: false });
  assert.deepEqual(run({ apiKey: 'secret', production: true }, 'secre'), { status: 403, nexted: false });
});

test('production sans API_KEY configurée → 503 (fermé)', () => {
  assert.deepEqual(run({ apiKey: '', production: true }, 'x'), { status: 503, nexted: false });
});

test('hors production : pas d’authentification', () => {
  assert.deepEqual(run({ apiKey: '', production: false }), { status: 0, nexted: true });
  assert.deepEqual(run({ apiKey: 'secret', production: false }), { status: 0, nexted: true });
});
