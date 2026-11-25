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
  dismissCookieBanner,
  fieldInputType,
  fillField,
  looseRegex,
  norm,
  settle,
  uploadFile,
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
        const cls = isHybrid(job.projectType) ? 'consuel-attestation-violet' : 'consuel-attestation-bleu';
        const nested = p.locator(`.${cls} [class~="24-plus"], .${cls}[class~="24-plus"]`).first();
        const card = p.locator(`.${cls}`).first();
        await card.waitFor({ state: 'visible' });
        if ((await nested.count()) > 0) await nested.click();
        else await card.click();
        await clickByText(p, 'Étape suivante');
        await settle(p);
      });

      await step('4. Formulaire du site', async () => {
        await fillField(p, 'nomSite', job.siteName);
        await fillField(p, 'proprietaireName', job.spv);
        await fillField(p, 'numAffaire', job.plantCode);
        if (address.numRue) await fillField(p, 'numRue', address.numRue);
        await fillField(p, 'nomRue', address.nomRue);
        await fillField(p, 'codePostal', address.codePostal);
        await settle(p);
        await chooseOption(p, p.locator('[formcontrolname="ville"]').first(), [address.ville], {
          fallbackIfSingle: true,
          attempts: 4,
        });
        await settle(p);
        await p.locator('.geolocalization-validation-container').first().click();
        await settle(p);
        await clickByText(p, 'Étape suivante');
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
        await chooseOption(p, p.locator('#typologieTypeId'), [typologieFor(job.projectType)]);
        await chooseOption(p, p.locator('#selectedSiteId'), ['Autre', 'Agricole', 'Stockage']);
        await settle(p);
        await chooseOption(p, p.locator('#typeProductionIdId'), ['LAST']);
        await settle(p);

        const powerType = await fieldInputType(p, 'puissanceInstallee');
        await fillField(p, 'puissanceInstallee', formatPower(job.injectedPower, powerType));
        await checkControl(p.locator('[formcontrolname="isTensionSubMille"]').first(), 0);
        await checkControl(p.locator('[formcontrolname="statutRapportOrganismeInspection"]').first(), 0);
        await uploadFile(p, p.locator('[formarrayname="rapportOrganismeInspection"]').first(), dre.filePath);
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
