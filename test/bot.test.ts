import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatPower, isHybrid, typologieFor } from '../src/bot';
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

  const ko = jobSchema.safeParse({ plantCode: '', dre: 'ftp://x' });
  assert.equal(ko.success, false);
});
