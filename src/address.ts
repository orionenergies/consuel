export interface ParsedAddress {
  /** Numéro de rue (optionnel), ex. "12" ou "12 bis" */
  numRue: string;
  /** Libellé de la voie, ex. "rue des Lilas" */
  nomRue: string;
  codePostal: string;
  ville: string;
}

const NUMBER_PREFIX = /^(\d+(?:\s?(?:bis|ter|quater)\b|\s[a-d](?=\s))?)[\s,]+(.+)$/i;

/**
 * Découpe une adresse française libre en numéro / voie / code postal / commune.
 * Exemples gérés :
 *  - "12 rue des Lilas, 34000 Montpellier"
 *  - "12 bis rue des Lilas 34000 Montpellier, France"
 *  - "Lieu-dit Les Plaines, 34000 Montpellier"
 */
export function parseAddress(address: string): ParsedAddress {
  const a = address.replace(/\s+/g, ' ').trim();

  const postalMatches = [...a.matchAll(/\b(\d{5})\b/g)];
  const last = postalMatches[postalMatches.length - 1];
  if (!last || last.index === undefined) {
    throw new Error(`Code postal introuvable dans l'adresse : "${address}"`);
  }

  const codePostal = last[1];
  const before = a.slice(0, last.index).replace(/[\s,;-]+$/g, '').trim();
  let after = a
    .slice(last.index + 5)
    .replace(/^[\s,;-]+/, '')
    .replace(/[\s,;]*\b(france)\b\s*$/i, '')
    .replace(/\s+cedex(\s+\d+)?\s*$/i, '')
    .replace(/[\s,;]+$/g, '')
    .trim();

  let street = before;
  if (!after) {
    // Format "rue X, Commune 34000" : la commune précède le code postal.
    const idx = Math.max(street.lastIndexOf(','), -1);
    if (idx > -1) {
      after = street.slice(idx + 1).trim();
      street = street.slice(0, idx).trim();
    }
  }

  if (!after) throw new Error(`Commune introuvable dans l'adresse : "${address}"`);
  if (!street) throw new Error(`Voie introuvable dans l'adresse : "${address}"`);

  let numRue = '';
  let nomRue = street;
  const m = street.match(NUMBER_PREFIX);
  if (m) {
    numRue = m[1].trim();
    nomRue = m[2].trim();
  }

  return { numRue, nomRue, codePostal, ville: after };
}
