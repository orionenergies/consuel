import { mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

import { chromium, type Browser, type Locator, type Page, type Video } from 'playwright';

import { parseAddress } from './address';
import { config, getCredentials } from './config';
import { downloadDre } from './download';
import {
  checkControl,
  chooseOption,
  clickByText,
  clickEnabledByText,
  dismissCookieBanner,
  fieldInputType,
  fillField,
  looseRegex,
  norm,
  settle,
} from './ionic';
import * as logger from './logger';
import type { Job } from './schema';

export interface VideoPayload {
  videoPath: string;
  videoBytes: number;
  videoBase64?: string;
  videoOmittedReason?: string;
}

export class StepError extends Error {
  constructor(
    public readonly step: string,
    message: string,
    public readonly screenshotPath?: string,
    public readonly screenshotBase64?: string,
    public readonly video?: VideoPayload,
  ) {
    super(message);
    this.name = 'StepError';
  }
}

export interface RunResult {
  status: 'success' | 'dry_run';
  plantCode: string;
  durationMs: number;
  steps: { name: string; durationMs: number }[];
  finalUrl: string;
  videoPath?: string;
  videoBase64?: string;
  videoBytes?: number;
  videoOmittedReason?: string;
}

/** Prépare la vidéo à renvoyer. Au-delà du plafond, le fichier reste sur disque mais sort de la réponse HTTP. */
export function buildVideoPayload(filePath: string, buffer: Buffer, maxBytes: number): VideoPayload {
  const payload: VideoPayload = { videoPath: filePath, videoBytes: buffer.length };
  if (buffer.length > maxBytes) {
    payload.videoOmittedReason = 'vidéo trop volumineuse pour la réponse HTTP';
    return payload;
  }
  payload.videoBase64 = buffer.toString('base64');
  return payload;
}

/** Valeurs de la liste "Typologie" selon le type de projet. */
export function typologieFor(projectType: string): string {
  const t = norm(projectType);
  if (t.includes('construction')) return 'Bâtiment neuf';
  if (t.includes('renovation')) return 'Bâtiment existant';
  return 'Sans bâtiment';
}

export function isHybrid(projectType: string): boolean {
  return norm(projectType).includes('hybride');
}

export function formatPower(power: number, inputType: string | null): string {
  const s = String(power);
  return inputType === 'number' ? s : s.replace('.', ',');
}

export async function runJob(job: Job): Promise<RunResult> {
  const startedAt = Date.now();
  const steps: RunResult['steps'] = [];
  const dryRun = job.dryRun ?? config.dryRun;
  const debug = job.debug === true;
  const { login, password } = getCredentials();
  const address = parseAddress(job.address);
  logger.info('Adresse analysée', { plantCode: job.plantCode, ...address });

  let browser: Browser | undefined;
  let page: Page | undefined;
  let recording: Video | null = null;
  let current = 'initialisation';
  const dre = await downloadDre(job.dre).catch((err: Error) => {
    throw new StepError('téléchargement du DRE', err.message);
  });
  logger.info('DRE téléchargé', { fileName: dre.fileName, bytes: dre.bytes });

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    current = name;
    const t0 = Date.now();
    logger.info(`Étape : ${name}`, { plantCode: job.plantCode });
    const out = await fn();
    steps.push({ name, durationMs: Date.now() - t0 });
    return out;
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    browser = await chromium.launch({
      headless: config.headless,
      slowMo: config.slowMo,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const recordDir = path.join(config.screenshotDir, '.video-raw');
    if (debug) {
      await mkdir(recordDir, { recursive: true });
      logger.info('Enregistrement vidéo activé', { plantCode: job.plantCode, dir: recordDir });
    }
    const context = await browser.newContext({
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
      viewport: { width: 1440, height: 900 },
      acceptDownloads: false,
      ...(debug ? { recordVideo: { dir: recordDir, size: { width: 1440, height: 900 } } } : {}),
    });
    context.setDefaultTimeout(config.actionTimeoutMs);
    page = await context.newPage();
    recording = page.video();
    const p = page;

    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Délai global dépassé (${config.runTimeoutMs} ms)`)),
        config.runTimeoutMs,
      );
    });

    const workflow = async (): Promise<RunResult> => {
      await step('1. Connexion', async () => {
        await p.goto(`${config.baseUrl}/connexion`, { waitUntil: 'domcontentloaded' });
        await settle(p);
        await dismissCookieBanner(p);
        await fillField(p, 'identifiant', login);
        await fillField(p, 'password', password);
        await p.locator('ion-button.connexion').click();
        try {
          await p.waitForURL((u) => !u.pathname.includes('/connexion'), { timeout: 30_000 });
        } catch {
          const msg = (await p.locator('ion-toast, ion-alert, .error, .erreur').allInnerTexts().catch(() => [])).join(' ').trim();
          throw new Error(`Échec de la connexion${msg ? ` : ${msg}` : ''}`);
        }
        await settle(p);
        await dismissCookieBanner(p);
      });

      await step('2. Nouveau dossier', async () => {
        await p.locator('.creer_dossier').first().click();
        await settle(p);
      });

      await step('3. Type d\'attestation', async () => {
        await clickAttestationPlus(p, isHybrid(job.projectType));
        await clickEnabledByText(p, 'Étape suivante');
        await settle(p);
      });

      await step('4. Formulaire du site', async () => {
        await fillField(p, 'nomSite', job.siteName);
        await fillField(p, 'proprietaireName', job.spv);
        await fillField(p, 'numAffaire', job.plantCode);
        await fillField(p, 'codePostal', address.codePostal);
        await settle(p);
        await chooseVille(p, address.ville, address.codePostal);
        await settle(p);
        if (address.numRue) await fillField(p, 'numRue', address.numRue);
        await fillField(p, 'nomRue', address.nomRue);
        await settle(p);
        await p.waitForTimeout(1_000);
        await p.locator('.geolocalization-validation-container').first().click();
        await settle(p);
        await clickEnabledByText(p, 'Étape suivante');
        await settle(p);
      });

      await step('5. Création du dossier', async () => {
        await clickByText(p, 'Créer le dossier');
        await settle(p, 60_000);
        await p.waitForTimeout(2_000);
      });

      await step('6. Mes attestations à envoyer', async () => {
        await clickByText(p, 'Mes attestations à envoyer');
        await settle(p);
      });

      await step('7. Ouverture de l\'attestation', async () => {
        const rows = p.locator('.pagination-liste-element--ligne');
        await rows.first().waitFor({ state: 'visible' });
        const idx = await rowIndexFor(rows, job.plantCode);
        await rows.nth(idx).click();
        await settle(p);
      });

      await step('8. Formulaire de l\'attestation', async () => {
        await chooseOption(p, await selectControl(p, 'typologieTypeId'), [typologieFor(job.projectType)]);
        await chooseOption(p, await selectControl(p, 'selectedSiteId', 'app-select-multilevel'), [
          'Autre',
          'Agricole',
          'Stockage - Entrepot',
        ]);
        await settle(p);
        await chooseOption(p, await selectControl(p, 'typeProductionIdId'), ['Photovoltaïque avec protection DC']);
        await settle(p);

        const powerType = await fieldInputType(p, 'puissanceInstallee');
        await fillField(p, 'puissanceInstallee', formatPower(job.injectedPower, powerType));
        await p.locator('ion-item').filter({ hasText: looseRegex('Inférieure ou égale') }).first().click();
        const toggle = p.locator('ion-toggle[formcontrolname="statutRapportOrganismeInspection"]').first();
        await toggle.waitFor({ state: 'visible' });
        if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
        await p.waitForTimeout(500);
        await importInspectionFile(p, dre.filePath);
        await settle(p, 60_000);
        await fillField(p, 'nomAttestation', `${job.plantCode} - Consuel`);
        await clickByText(p, /^\s*enregistrer\s*$/i);
        await settle(p, 60_000);
      });

      await step('9. Envoi au Consuel', async () => {
        const rows = p.locator('.pagination-liste-element--ligne');
        await rows.first().waitFor({ state: 'visible' });
        const idx = await rowIndexFor(rows, job.plantCode);
        await checkControl(p.locator('.pagination-liste-element--checkbox').nth(idx), 0);
        await p.locator('.envoyer').first().click();
        await settle(p, 60_000);
      });

      await step('10. Confirmation et enregistrement', async () => {
        await clickByText(p, /^\s*confirmer\s*$/i);
        await settle(p, 30_000);
        await clickByText(p, /^\s*enregistrer\s*$/i);
        await settle(p, 60_000);
      });

      const finalStep = dryRun ? '11. Je confirme (DRY RUN, pas de signature)' : '11. Signature et envoi';
      await step(finalStep, async () => {
        const confirmBox = p
          .locator('ion-checkbox, mat-checkbox, label')
          .filter({ hasText: looseRegex('Je confirme') })
          .filter({ visible: true })
          .first();
        await confirmBox.waitFor({ state: 'visible' });
        await checkControl(confirmBox, 0);
        if (dryRun) return;
        await clickByText(p, 'Signer et envoyer');
        await settle(p, 60_000);
        await p.waitForTimeout(2_000);
      });

      return {
        status: dryRun ? 'dry_run' : 'success',
        plantCode: job.plantCode,
        durationMs: Date.now() - startedAt,
        steps,
        finalUrl: p.url(),
      };
    };

    const workflowPromise = workflow();
    // Si le délai global gagne la course, le workflow peut encore rejeter après la fermeture de la page.
    void workflowPromise.catch(() => undefined);
    const result = await Promise.race([workflowPromise, timedOut]);
    const video = await finalizeVideo(page, recording, job.plantCode);
    return { ...result, ...video };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stepName = err instanceof StepError ? err.step : current;
    if (err instanceof StepError) throw err;
    const shot = await captureFailure(page, job.plantCode);
    const video = await finalizeVideo(page, recording, job.plantCode);
    throw new StepError(stepName, message, shot?.filePath, shot?.base64, video);
  } finally {
    if (timer) clearTimeout(timer);
    await browser?.close().catch(() => undefined);
    await dre.cleanup().catch(() => undefined);
  }
}

/**
 * Clique le « + » de la carte violette (hybride) ou bleue.
 * Le bouton est l'ion-button qui contient ion-icon[name="24-plus"][aria-label="24 plus"].
 * L'icône ne reçoit pas le pointeur : le clic doit partir du bouton (bouton natif du shadow DOM).
 * « Étape suivante » est déjà visible, mais il reste désactivé tant que ce « + » n'a pas été cliqué.
 */
async function clickAttestationPlus(page: Page, hybrid: boolean): Promise<void> {
  const zone = hybrid ? 'violette' : 'bleue';
  const cls = hybrid ? 'consuel-attestation-violet' : 'consuel-attestation-bleu';
  const card = page.locator(`.${cls}`).first();
  await card.waitFor({ state: 'visible' });
  const plus = card.locator('ion-button:has(ion-icon[name="24-plus"][aria-label="24 plus"])').first();
  try {
    await plus.waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    throw new Error(`Bouton + introuvable dans la zone ${zone}`);
  }
  logger.info(`Clic sur + dans la zone ${zone}`);
  const native = plus.locator('button');
  const target = (await native.count()) > 0 ? native.first() : plus;
  await target.scrollIntoViewIfNeeded();
  await target.dispatchEvent('click');
}

/** ion-select, ou app-select-multilevel, identifié par son id (éventuellement sur un parent). */
async function selectControl(page: Page, id: string, tag = 'ion-select'): Promise<Locator> {
  const byId = page.locator(`#${id}`).first();
  await byId.waitFor({ state: 'visible' });
  const hostTag = await byId.evaluate((el) => el.tagName.toLowerCase());
  if (hostTag === tag) return byId;
  const inner = byId.locator(tag).first();
  if ((await inner.count()) > 0) return inner;
  return byId;
}

/** Importe le DRE via la zone qui apparaît après l'interrupteur du rapport. */
async function importInspectionFile(page: Page, filePath: string): Promise<void> {
  const zone = page.locator('.import-multiple-file-container').first();
  await zone.waitFor({ state: 'visible', timeout: 15_000 });
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 1_500 }).catch(() => null);
  await zone.click();
  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.setFiles(filePath);
    return;
  }
  const input = zone.locator('input[type="file"]');
  if ((await input.count()) > 0) {
    await input.setInputFiles(filePath);
    return;
  }
  throw new Error("Import du DRE impossible : la zone .import-multiple-file-container n'a pas ouvert de fichier");
}

/** « Feurs » + 42110 correspond au libellé exact « FEURS (42110) », pas à un nom qui le contient. */
function villeLabelPattern(ville: string, codePostal: string): RegExp {
  const folded = ville.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const words = folded
    .split(/[^0-9A-Za-z]+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^\\s*${words.join('\\s+')}\\s*\\(\\s*${codePostal}\\s*\\)\\s*$`, 'i');
}

/**
 * Choisit la commune dans l'ion-select-popover du champ ville.
 * Chaque option est un ion-item.select-interface-option : le texte est dans ion-label
 * (« FEURS (42110) ») et le clic part du ion-radio. La liste peut n'afficher qu'une
 * fenêtre (popover-viewport) : on la fait défiler tant que de nouvelles communes apparaissent.
 */
async function chooseVille(page: Page, ville: string, codePostal: string): Promise<void> {
  const control = page.locator('[formcontrolname="ville"]').first();
  await control.waitFor({ state: 'visible' });
  const label = `${ville.toLocaleUpperCase('fr-FR')} (${codePostal})`;
  const pattern = villeLabelPattern(ville, codePostal);
  let lastTexts: string[] = [];

  for (let attempt = 1; attempt <= 4; attempt++) {
    await control.click();
    const popover = page.locator('ion-select-popover').last();
    const opened = await popover
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (!opened) {
      logger.warn('Option introuvable, nouvelle tentative', { label, attempt, disponibles: [] });
      continue;
    }

    const deadline = Date.now() + 8_000;
    let signature = '';
    let stagnant = 0;
    while (Date.now() < deadline) {
      const match = popover.locator('ion-label').filter({ hasText: pattern }).first();
      if ((await match.count()) > 0) {
        const text = (await match.innerText()).replace(/\s+/g, ' ').trim();
        const item = match.locator('xpath=ancestor::ion-item[1]');
        const radio = item.locator('ion-radio').first();
        logger.info('Commune choisie', { text });
        if ((await radio.count()) > 0) {
          const native = radio.locator('button');
          if ((await native.count()) > 0) await native.first().click();
          else await radio.click();
        } else {
          await item.click();
        }
        return;
      }

      const texts = (await popover.locator('ion-label').allInnerTexts())
        .map((t) => t.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (texts.length > 0) lastTexts = texts;
      const next = texts.join('\n');
      stagnant = next.length > 0 && next === signature ? stagnant + 1 : 0;
      signature = next;
      if (stagnant >= 1) break;
      await popover.evaluate((el) => {
        const scroller = el.classList.contains('popover-viewport')
          ? el
          : ((el.querySelector('.popover-viewport') as HTMLElement | null) ?? el);
        scroller.scrollTop += Math.max(scroller.clientHeight - 24, 40);
      });
      await page.waitForTimeout(200);
    }

    logger.warn('Option introuvable, nouvelle tentative', { label, attempt, disponibles: lastTexts.slice(0, 30) });
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);
  }

  throw new Error(`Option introuvable : ${label} (disponibles : ${lastTexts.slice(0, 30).join(' | ') || 'aucune'})`);
}

/** Index de la ligne de la liste correspondant au plantCode (sinon la première). */
async function rowIndexFor(rows: Locator, plantCode: string): Promise<number> {
  const texts = await rows.allInnerTexts();
  const wanted = norm(plantCode);
  const idx = texts.findIndex((t) => norm(t).includes(wanted));
  if (idx < 0) logger.warn('Ligne correspondant au plantCode introuvable, utilisation de la première', { plantCode });
  return Math.max(idx, 0);
}

/** Ferme la page pour flush la vidéo Playwright, puis la copie sous un nom stable. */
async function finalizeVideo(
  page: Page | undefined,
  video: Video | null,
  plantCode: string,
): Promise<VideoPayload | undefined> {
  if (!video) return undefined;
  const safe = plantCode.replace(/[^\w-]/g, '_');
  const filePath = path.join(config.screenshotDir, `${safe}-${Date.now()}.webm`);
  try {
    await mkdir(config.screenshotDir, { recursive: true });
    const saving = video.saveAs(filePath);
    if (page && !page.isClosed()) await page.close().catch(() => undefined);
    await saving;
    const raw = await video.path().catch(() => undefined);
    if (raw && path.resolve(raw) !== path.resolve(filePath)) await unlink(raw).catch(() => undefined);
    const buffer = await readFile(filePath);
    logger.info('Vidéo enregistrée', { filePath, bytes: buffer.length });
    return buildVideoPayload(filePath, buffer, config.videoMaxBytes);
  } catch (e) {
    logger.warn('Vidéo impossible', { error: String(e) });
    // saveAs peut avoir écrit un fichier partiel : on tente de le relire.
    try {
      const buffer = await readFile(filePath);
      if (buffer.length > 0) return buildVideoPayload(filePath, buffer, config.videoMaxBytes);
    } catch {
      await unlink(filePath).catch(() => undefined);
    }
    return undefined;
  }
}

async function captureFailure(
  page: Page | undefined,
  plantCode: string,
): Promise<{ filePath: string; base64?: string } | undefined> {
  if (!page || page.isClosed()) return undefined;
  try {
    await mkdir(config.screenshotDir, { recursive: true });
    const safe = plantCode.replace(/[^\w-]/g, '_');
    const filePath = path.join(config.screenshotDir, `${safe}-${Date.now()}.png`);
    const buffer = await page.screenshot({ path: filePath, fullPage: true, timeout: 10_000 });
    logger.warn('Capture d\'écran enregistrée', { filePath, url: page.url() });
    return { filePath, base64: config.returnScreenshot ? buffer.toString('base64') : undefined };
  } catch (e) {
    logger.warn('Capture d\'écran impossible', { error: String(e) });
    return undefined;
  }
}
