import type { Locator, Page } from 'playwright';

import { warn } from './logger';

/** Normalise un libellé pour comparer sans tenir compte de la casse, des accents et de la ponctuation. */
export const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[-'’_.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex insensible à la casse et aux accents les plus courants (é, è, ê...). */
export const looseRegex = (text: string): RegExp => {
  const pattern = escapeRe(text)
    .replace(/[éèêë]/gi, '[éèêëeÉÈÊË]')
    .replace(/[àâä]/gi, '[àâäaÀÂÄ]')
    .replace(/[ôö]/gi, '[ôöoÔÖ]')
    .replace(/[ùûü]/gi, '[ùûüuÙÛÜ]')
    .replace(/[îï]/gi, '[îïiÎÏ]')
    .replace(/\s+/g, '\\s+');
  return new RegExp(pattern, 'i');
};

/** Attend la fin des appels réseau et la disparition des overlays de chargement Ionic. */
export async function settle(page: Page, timeout = 15_000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => undefined);
  await page
    .locator('ion-loading')
    .first()
    .waitFor({ state: 'hidden', timeout })
    .catch(() => undefined);
}

/** Ferme la bannière cookies si elle est présente (non bloquant). */
export async function dismissCookieBanner(page: Page): Promise<void> {
  const btn = page
    .locator('button, ion-button, a')
    .filter({ hasText: /non merci|tout refuser|continuer sans accepter|tout accepter|j'accepte|ok pour moi/i })
    .filter({ visible: true })
    .first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click({ timeout: 3_000 }).catch(() => undefined);
  }
}

/** Clique sur un bouton/lien visible dont le texte correspond. */
export async function clickByText(
  page: Page,
  text: string | RegExp,
  opts: { scope?: Locator; timeout?: number } = {},
): Promise<void> {
  const re = typeof text === 'string' ? looseRegex(text) : text;
  const root = opts.scope ?? page;
  const timeout = opts.timeout ?? 30_000;
  const buttons = root
    .locator('ion-button, button, a, [role="button"]')
    .filter({ hasText: re })
    .filter({ visible: true });
  const textNodes = root.getByText(re).filter({ visible: true });

  // Les vrais boutons sont prioritaires ; à défaut (menu, carte cliquable), on clique sur le texte.
  const deadline = Date.now() + timeout;
  const textFallbackAfter = Date.now() + Math.min(5_000, timeout / 2);
  while (Date.now() < deadline) {
    if ((await buttons.count()) > 0) {
      await buttons.first().click({ timeout: Math.max(deadline - Date.now(), 1_000) });
      return;
    }
    if (Date.now() >= textFallbackAfter && (await textNodes.count()) > 0) {
      await textNodes.first().click({ timeout: Math.max(deadline - Date.now(), 1_000) });
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Bouton ou texte introuvable : ${String(text)}`);
}

/** Remplit un champ Angular (ion-input, input, textarea) identifié par formcontrolname. */
export async function fillField(page: Page, controlName: string, value: string): Promise<void> {
  const host = page.locator(`[formcontrolname="${controlName}"]`).first();
  await host.waitFor({ state: 'visible' });
  const inner = host.locator('input:not([type="hidden"]), textarea').first();
  const target = (await inner.count()) > 0 ? inner : host;
  await target.fill(value);
  await target.blur().catch(() => undefined);
}

/** Retourne l'attribut `type` du champ interne (ex. "number") pour adapter le format des nombres. */
export async function fieldInputType(page: Page, controlName: string): Promise<string | null> {
  const inner = page.locator(`[formcontrolname="${controlName}"]`).first().locator('input').first();
  if ((await inner.count()) === 0) return null;
  return inner.getAttribute('type');
}

const OPTION_SELECTOR = [
  'ion-select-popover ion-item',
  'ion-select-popover ion-radio',
  'ion-popover ion-item',
  'ion-modal ion-item',
  'ion-alert button.alert-radio-button',
  'ion-alert button.alert-checkbox-button',
  'ion-action-sheet button.action-sheet-button',
  'mat-option',
  'ng-option',
  '.ng-option',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="treeitem"]',
].join(', ');

export type OptionChoice = string | 'FIRST' | 'LAST';

async function visibleOptions(page: Page): Promise<{ locator: Locator; texts: string[] }> {
  const locator = page.locator(OPTION_SELECTOR).filter({ visible: true });
  const texts = (await locator.allInnerTexts()).map((t) => t.trim());
  return { locator, texts };
}

function pickIndex(texts: string[], choice: OptionChoice): number {
  if (choice === 'FIRST') return texts.length ? 0 : -1;
  if (choice === 'LAST') return texts.length - 1;
  const wanted = norm(choice);
  const exact = texts.findIndex((t) => norm(t) === wanted);
  if (exact >= 0) return exact;
  const contains = texts.findIndex((t) => norm(t).includes(wanted));
  if (contains >= 0) return contains;
  return texts.findIndex((t) => t && wanted.includes(norm(t)));
}

async function confirmOverlayIfAny(page: Page): Promise<void> {
  const confirm = page
    .locator('ion-alert button.alert-button, ion-select-popover ion-button')
    .filter({ hasText: /^\s*(ok|valider|confirmer)\s*$/i })
    .filter({ visible: true })
    .first();
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click().catch(() => undefined);
  }
}

export interface SelectOptions {
  /** Si une seule option est proposée et qu'aucune ne correspond, la choisir quand même. */
  fallbackIfSingle?: boolean;
  /** Nombre de tentatives d'ouverture de la liste (utile pour les listes alimentées par une API). */
  attempts?: number;
}

/**
 * Sélectionne une valeur dans une liste déroulante, quelle que soit sa technologie
 * (select natif, ion-select, mat-select, ng-select...).
 *
 * `path` permet les listes en cascade (ex. Autre > Agricole > Stockage) : chaque
 * élément est cherché dans les options visibles après le clic précédent.
 */
export async function chooseOption(
  page: Page,
  control: Locator,
  path: OptionChoice[],
  opts: SelectOptions = {},
): Promise<void> {
  await control.waitFor({ state: 'visible' });
  const tag = await control.evaluate((el) => el.tagName.toLowerCase());

  if (tag === 'select') {
    const options = (await control.locator('option').allInnerTexts()).map((t) => t.trim());
    const idx = pickIndex(options, path[path.length - 1]);
    if (idx < 0) throw new Error(`Option introuvable dans <select> : ${path.join(' > ')} (disponibles : ${options.join(' | ')})`);
    await control.selectOption({ index: idx });
    return;
  }

  const attempts = opts.attempts ?? 3;
  let lastTexts: string[] = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await control.click();

    let ok = true;
    for (let level = 0; level < path.length; level++) {
      const choice = path[level];
      let found = false;
      for (let poll = 0; poll < 20 && !found; poll++) {
        const { locator, texts } = await visibleOptions(page);
        lastTexts = texts;
        if (texts.length > 0) {
          let idx = pickIndex(texts, choice);
          if (idx < 0 && opts.fallbackIfSingle && level === path.length - 1 && texts.length === 1) idx = 0;
          if (idx >= 0) {
            await locator.nth(idx).click();
            found = true;
            break;
          }
        }
        await page.waitForTimeout(250);
      }
      if (!found) {
        ok = false;
        break;
      }
      await page.waitForTimeout(300);
    }

    if (ok) {
      await confirmOverlayIfAny(page);
      return;
    }

    warn('Option introuvable, nouvelle tentative', { path, attempt, disponibles: lastTexts.slice(0, 30) });
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(1_000);
  }

  throw new Error(`Option introuvable : ${path.join(' > ')} (disponibles : ${lastTexts.slice(0, 30).join(' | ') || 'aucune'})`);
}

/**
 * Coche une case / un bouton radio d'un contrôle Angular. `index` désigne l'élément
 * (0 = premier). Ne fait rien si l'élément est déjà coché.
 */
export async function checkControl(host: Locator, index = 0): Promise<void> {
  await host.waitFor({ state: 'visible' });
  const inner = host.locator(
    'ion-radio, ion-checkbox, ion-toggle, mat-radio-button, mat-checkbox, input[type="checkbox"], input[type="radio"]',
  );
  const target = (await inner.count()) > index ? inner.nth(index) : host;

  const alreadyChecked = await target.evaluate((el) => {
    const e = el as HTMLElement & { checked?: boolean };
    return (
      e.checked === true ||
      e.getAttribute('aria-checked') === 'true' ||
      /\b(checkbox-checked|radio-checked|mat-mdc-radio-checked|mat-mdc-checkbox-checked)\b/.test(e.className)
    );
  });
  if (!alreadyChecked) await target.click();
}

/** Envoie un fichier via un <input type="file"> (même caché) ou via la boîte de dialogue de fichier. */
export async function uploadFile(page: Page, scope: Locator, filePath: string): Promise<void> {
  await scope.waitFor({ state: 'attached' });
  const input = scope.locator('input[type="file"]').first();
  if ((await input.count()) > 0) {
    await input.setInputFiles(filePath);
    return;
  }
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10_000 }),
    scope.locator('ion-button, button, ion-icon, label, a').filter({ visible: true }).first().click(),
  ]);
  await chooser.setFiles(filePath);
}
