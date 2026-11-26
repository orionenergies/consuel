import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { after, before, test } from 'node:test';

import { startMockSite } from './mock-site';

// Ces variables doivent être posées avant l'import du bot (config lue paresseusement).
process.env.CONSUEL_LOGIN = 'login-test';
process.env.CONSUEL_PASSWORD = 'mdp-test';
process.env.ALLOW_PRIVATE_DRE_URLS = 'true';
process.env.SCREENSHOT_DIR = '/tmp/consuel-test-screenshots';

let site: Awaited<ReturnType<typeof startMockSite>>;

before(async () => {
  site = await startMockSite();
  process.env.BASE_URL = site.url;
});
after(async () => {
  await site.close();
});

const baseJob = (over: Record<string, unknown> = {}) => ({
  plantCode: 'PV001',
  injectedPower: 99.5,
  address: '12 bis rue des Lilas, 34000 Montpellier',
  projectType: 'Rénovation',
  siteName: 'Site de test',
  spv: 'SPV Test',
  dre: '',
  ...over,
});

test('workflow complet sur le faux site', { timeout: 120_000 }, async () => {
  const { runJob } = await import('../src/bot');
  const { jobSchema } = await import('../src/schema');
  const job = jobSchema.parse(baseJob({ dre: `${site.url}/dre.pdf` }));

  const result = await runJob(job);
  assert.equal(result.status, 'success');
  assert.equal(result.videoPath, undefined);

  const ev = (type: string) => site.events.filter((e) => e.type === type);
  const field = (name: string) => ev('field').filter((e) => e.name === name).pop()?.value;

  assert.deepEqual(ev('login')[0], { type: 'login', id: 'login-test', pw: 'mdp-test' });
  assert.equal(ev('type')[0].hybrid, false);
  assert.equal(field('nomSite'), 'Site de test');
  assert.equal(field('proprietaireName'), 'SPV Test');
  assert.equal(field('numAffaire'), 'PV001');
  assert.equal(field('numRue'), '12 bis');
  assert.equal(field('nomRue'), 'rue des Lilas');
  assert.equal(field('codePostal'), '34000');
  assert.deepEqual(ev('select').find((e) => e.name === 'ville')?.path, ['MONTPELLIER (34000)']);
  const addressOrder = site.events
    .filter((e) => (e.type === 'field' && (e.name === 'codePostal' || e.name === 'numRue' || e.name === 'nomRue')) || (e.type === 'select' && e.name === 'ville') || e.type === 'geoloc')
    .map((e) => (e.type === 'field' || e.type === 'select' ? `${e.type}:${e.name}` : e.type));
  assert.deepEqual(addressOrder, ['field:codePostal', 'select:ville', 'field:numRue', 'field:nomRue', 'geoloc']);
  assert.equal(ev('geoloc').length, 1);
  assert.equal(ev('create').length, 1);
  assert.match(String(ev('open')[0].row), /PV001/);
  assert.deepEqual(ev('select').find((e) => e.name === 'typologie')?.path, ['Bâtiment existant']);
  assert.deepEqual(ev('select').find((e) => e.name === 'site')?.path, ['Autre', 'Agricole', 'Stockage']);
  assert.deepEqual(ev('select').find((e) => e.name === 'production')?.path, ['Photovoltaïque avec protection DC']);
  assert.equal(field('puissanceInstallee'), '99.5');
  assert.deepEqual(ev('radio'), [{ type: 'radio', index: 0 }]);
  assert.equal(ev('check').filter((e) => e.name === 'statutRapport').length, 1);
  assert.equal(ev('file')[0].name, 'dre.pdf');
  assert.equal(field('nomAttestation'), 'PV001 - Consuel');
  assert.equal(ev('save').length, 1);
  assert.deepEqual(ev('check').filter((e) => e.name === 'row1' && e.checked).length, 1);
  assert.equal(ev('check').filter((e) => e.name === 'row0').length, 0);
  assert.equal(ev('envoyer').length, 1);
  assert.equal(ev('confirmer').length, 1);
  assert.equal(ev('signed').length, 1);
});

test('projet hybride : carte violette, bâtiment neuf et dry run', { timeout: 120_000 }, async () => {
  const { runJob } = await import('../src/bot');
  const { jobSchema } = await import('../src/schema');
  site.events.length = 0;
  const job = jobSchema.parse(
    baseJob({ dre: `${site.url}/dre.pdf`, projectType: 'Construction Hybride', dryRun: true, debug: true }),
  );

  const result = await runJob(job);
  assert.equal(result.status, 'dry_run');
  assert.ok(result.videoPath?.endsWith('.webm'));
  assert.ok(result.videoBase64);
  const video = Buffer.from(result.videoBase64, 'base64');
  assert.equal(video.subarray(0, 4).toString('hex'), '1a45dfa3');
  assert.equal(result.videoBytes, video.length);
  await access(result.videoPath);
  assert.equal(site.events.find((e) => e.type === 'type')?.hybrid, true);
  assert.deepEqual(
    site.events.find((e) => e.type === 'select' && e.name === 'typologie')?.path,
    ['Bâtiment neuf'],
  );
  assert.equal(site.events.filter((e) => e.type === 'signed').length, 0);
});

test('erreur claire si la commune est introuvable', { timeout: 120_000 }, async () => {
  const { runJob, StepError } = await import('../src/bot');
  const { jobSchema } = await import('../src/schema');
  const job = jobSchema.parse(
    baseJob({ dre: `${site.url}/dre.pdf`, address: '1 rue X, 34000 Nulle-Part-Sur-Mer', debug: true }),
  );
  await assert.rejects(runJob(job), (err: unknown) => {
    assert.ok(err instanceof StepError);
    assert.match(err.step, /Formulaire du site/);
    assert.match(err.message, /Option introuvable/);
    assert.ok(err.video?.videoPath?.endsWith('.webm'));
    assert.equal(Buffer.from(err.video?.videoBase64 ?? '', 'base64').subarray(0, 4).toString('hex'), '1a45dfa3');
    return true;
  });
});

test('le DRE ne peut pas pointer vers le réseau interne', async () => {
  process.env.ALLOW_PRIVATE_DRE_URLS = 'false';
  const { assertPublicUrl } = await import('../src/download');
  await assert.rejects(assertPublicUrl('http://169.254.169.254/computeMetadata/v1/'), /non publique/);
  await assert.rejects(assertPublicUrl('http://127.0.0.1:8080/x'), /non publique/);
  await assert.rejects(assertPublicUrl('file:///etc/passwd'), /Protocole/);
  process.env.ALLOW_PRIVATE_DRE_URLS = 'true';
});
