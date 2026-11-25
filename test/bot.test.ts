import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildVideoPayload, formatPower, isHybrid, typologieFor } from '../src/bot';
import { norm } from '../src/ionic';
import { jobSchema } from '../src/schema';

test('typologie selon le projectType', () => {
  assert.equal(typologieFor('Construction'), 'Bâtiment neuf');
  assert.equal(typologieFor('Rénovation'), 'Bâtiment existant');
  assert.equal(typologieFor('renovation hybride'), 'Bâtiment existant');
  assert.equal(typologieFor('Ombrière'), 'Sans bâtiment');
});

test('détection du type hybride', () => {
  assert.equal(isHybrid('Projet Hybride'), true);
  assert.equal(isHybrid('Autoconsommation'), false);
});

test('format de la puissance', () => {
  assert.equal(formatPower(99.5, 'number'), '99.5');
  assert.equal(formatPower(99.5, 'text'), '99,5');
  assert.equal(formatPower(100, null), '100');
});

test('normalisation des libellés', () => {
  assert.equal(norm('  Saint-Étienne '), 'saint etienne');
});

test('validation du JSON d\'entrée', () => {
  const ok = jobSchema.safeParse({
    plantCode: 'PV001',
    injectedPower: '250.5',
    address: '1 rue X, 34000 Montpellier',
    projectType: 'Construction',
    siteName: 'Site',
    spv: 'SPV',
    dre: 'https://example.com/dre.pdf',
  });
  assert.equal(ok.success, true);
  assert.equal(ok.data?.injectedPower, 250.5);
  assert.equal(ok.data?.debug, undefined);

  const withDebug = jobSchema.safeParse({ ...ok.data, debug: true });
  assert.equal(withDebug.success, true);
  assert.equal(withDebug.data?.debug, true);

  const ko = jobSchema.safeParse({ plantCode: '', dre: 'ftp://x' });
  assert.equal(ko.success, false);
});

test('la vidéo dépasse le plafond : fichier conservé, base64 omis', () => {
  const small = buildVideoPayload('/tmp/a.webm', Buffer.from('webm'), 10);
  assert.equal(small.videoBase64, Buffer.from('webm').toString('base64'));
  assert.equal(small.videoOmittedReason, undefined);

  const big = buildVideoPayload('/tmp/a.webm', Buffer.from('webm-trop-gros'), 4);
  assert.equal(big.videoBase64, undefined);
  assert.equal(big.videoBytes, Buffer.from('webm-trop-gros').length);
  assert.match(big.videoOmittedReason ?? '', /trop volumineuse/);
});
