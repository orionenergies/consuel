import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseAddress } from '../src/address';

test('adresse standard avec numéro', () => {
  assert.deepEqual(parseAddress('12 rue des Lilas, 34000 Montpellier'), {
    numRue: '12',
    nomRue: 'rue des Lilas',
    codePostal: '34000',
    ville: 'Montpellier',
  });
});

test('numéro avec complément bis et pays', () => {
  assert.deepEqual(parseAddress('12 bis, avenue de la Gare 13100 Aix-en-Provence, France'), {
    numRue: '12 bis',
    nomRue: 'avenue de la Gare',
    codePostal: '13100',
    ville: 'Aix-en-Provence',
  });
});

test('lettre de complément', () => {
  const r = parseAddress('7 B rue Victor Hugo, 75011 Paris');
  assert.equal(r.numRue, '7 B');
  assert.equal(r.nomRue, 'rue Victor Hugo');
});

test('un nom de voie commençant par une lettre n\'est pas pris pour un complément', () => {
  const r = parseAddress('3 allée des Pins, 33000 Bordeaux');
  assert.equal(r.numRue, '3');
  assert.equal(r.nomRue, 'allée des Pins');
});

test('sans numéro (lieu-dit)', () => {
  const r = parseAddress('Lieu-dit Les Plaines, 34000 Montpellier');
  assert.equal(r.numRue, '');
  assert.equal(r.nomRue, 'Lieu-dit Les Plaines');
});

test('commune avant le code postal', () => {
  const r = parseAddress('5 chemin du Moulin, Castelnau 34170');
  assert.equal(r.ville, 'Castelnau');
  assert.equal(r.codePostal, '34170');
  assert.equal(r.nomRue, 'chemin du Moulin');
});

test('cedex ignoré', () => {
  assert.equal(parseAddress('1 place de la Mairie 69001 Lyon Cedex 01').ville, 'Lyon');
});

test('sans code postal : erreur', () => {
  assert.throws(() => parseAddress('rue des Lilas Montpellier'), /Code postal/);
});
