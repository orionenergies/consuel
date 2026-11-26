# consuel

Bot qui dépose automatiquement une attestation Consuel sur [monespaceconsuel.com](https://www.monespaceconsuel.com/connexion).
Il est écrit en TypeScript avec Playwright (Chromium), exposé en HTTP et prévu pour être déployé sur Google Cloud Run.

## Entrée

Requête `POST /run` avec un corps JSON :

| Champ           | Type     | Rôle                                                                    |
| --------------- | -------- | ----------------------------------------------------------------------- |
| `plantCode`     | string   | N° d'affaire (`numAffaire`) et nom de l'attestation (`<plantCode> - Consuel`) |
| `injectedPower` | number   | Puissance installée (`puissanceInstallee`)                              |
| `address`       | string   | Adresse libre, découpée en n° de rue / voie / code postal / commune     |
| `projectType`   | string   | Contient `Hybride` : carte violette. Contient `Construction` : bâtiment neuf. Contient `Rénovation` : bâtiment existant. Sinon : sans bâtiment |
| `siteName`      | string   | Nom du site (`nomSite`)                                                 |
| `spv`           | string   | Propriétaire (`proprietaireName`)                                       |
| `dre`           | url      | URL http(s) du DRE (rapport de l'organisme d'inspection), téléchargé puis importé |
| `dryRun`        | boolean  | Optionnel. Si `true`, le bot s'arrête avant « Signer et envoyer »       |
| `debug`         | boolean  | Optionnel. Si `true`, enregistre l'écran et renvoie la vidéo webm       |

```json
{
  "plantCode": "PV001",
  "injectedPower": 99.5,
  "address": "12 bis rue des Lilas, 34000 Montpellier",
  "projectType": "Construction",
  "siteName": "Site de Montpellier",
  "spv": "SPV Montpellier SAS",
  "dre": "https://example.com/dre.pdf"
}
```

### Réponses

- `200` : `{ "status": "success" | "dry_run", "plantCode", "durationMs", "steps": [...], "finalUrl" }`. Avec `debug: true`, ajoute `videoPath`, `videoBytes` et `videoBase64` (webm)
- `400` : JSON d'entrée invalide (`status: "invalid_request"` et liste des erreurs)
- `429` : un traitement est déjà en cours (un seul run à la fois par instance)
- `500` : `{ "status": "error", "step", "message", "screenshotPath" }`. `step` indique l'étape du workflow en échec. Avec `debug: true`, la même vidéo est jointe

`debug: true` filme tout le run (succès ou erreur). Le fichier `.webm` est écrit dans `SCREENSHOT_DIR`, et son contenu est renvoyé en base64 pour Make.com. Au-delà de `VIDEO_MAX_BYTES` (16 Mio par défaut), le fichier reste sur le disque du conteneur et la réponse contient `videoOmittedReason` à la place de `videoBase64` : la réponse HTTP de Cloud Run est limitée à 32 Mio. Pour relire la vidéo : décoder `videoBase64` et l'enregistrer en `.webm`.

`GET /healthz` renvoie `{ "status": "ok" }`.

`GET /diag` (protégé par `x-api-key` en production) renvoie l'IP de sortie du service et le code HTTP reçu du site et de son API (`api.bloque: true` si le pare-feu du Consuel répond 403). À appeler après le premier déploiement.

## Workflow automatisé

1. Connexion (`identifiant`, `password`, bouton `.connexion`), la bannière cookies est refusée si elle apparaît
2. Clic sur `.creer_dossier`
3. Clic sur le « + » de `.consuel-attestation-violet` (projet hybride) ou `.consuel-attestation-bleu` : l'`ion-button` qui contient `ion-icon[name="24-plus"][aria-label="24 plus"]` (le bouton « − » voisin, `24-moins`, est ignoré). « Étape suivante » n'est cliqué qu'une fois actif : il est visible mais désactivé avant ce « + »
4. Formulaire du site : `nomSite`, `proprietaireName`, `numAffaire`, puis `codePostal`. La saisie du code postal ouvre souvent déjà l'`ion-select-popover` : le bot ne clique `aria-label="Choisissez votre ville"` que si cette liste est absente. Le libellé exact est dans `ion-label` (`FEURS (42110)`, espaces et accents ignorés) et le clic porte sur toute la ligne `ion-item`. La liste défile si la commune n'est pas encore affichée. Ensuite seulement `numRue` et `nomRue`, pour que le pointeur de la carte se place. Une seconde d'attente, puis `.geolocalization-validation-container` et « Étape suivante »
5. « Créer le dossier »
6. « Mes attestations à envoyer »
7. Ouverture de la ligne `.pagination-liste-element--ligne` (celle qui contient le `plantCode`, sinon la première)
8. Formulaire de l'attestation, dans cet ordre : `ion-select#typologieTypeId` (`role="button"`, options Bâtiment neuf, Bâtiment existant, Sans bâtiment), puis `app-select-multilevel#selectedSiteId`. Chaque niveau est une ligne `ion-item.ion-item-select` : Autre, puis Agricole, puis « Stockage – Entrepôt (silos céréales…) ». Les sous-listes dans `.overlay-hidden` sont ignorées. Ensuite `ion-select#typeProductionIdId` et la ligne « Photovoltaïque avec protection DC », `puissanceInstallee`, ligne `ion-item` « Inférieure ou égale », `ion-toggle[formcontrolname=statutRapportOrganismeInspection]`, puis 0,5 s et clic sur `.import-multiple-file-container` pour le DRE, `nomAttestation`, « Enregistrer »
9. Case `.pagination-liste-element--checkbox` de la ligne, puis `.envoyer`
10. « Confirmer » puis « Enregistrer »
11. Case « Je confirme » puis « Signer et envoyer »

Le fichier `src/bot.ts` contient le workflow, et `src/ionic.ts` les fonctions génériques (listes déroulantes Ionic, cases à cocher, upload).

## Configuration

Les variables d'environnement sont décrites dans `.env.example`. Les deux obligatoires sont `CONSUEL_LOGIN` et `CONSUEL_PASSWORD`, plus `API_KEY` en production (voir « Clé d'API »).
Les identifiants ne sont jamais dans le code : en local, utiliser un fichier `.env` (ignoré par git) ; sur Cloud Run, Secret Manager.

Autres options utiles : `HEADLESS=false` (voir le navigateur), `SLOW_MO_MS`, `DRY_RUN=true`, `RETURN_SCREENSHOT=true` (capture d'erreur en base64 dans la réponse 500).

## Utilisation en local

```bash
npm install
npx playwright install chromium     # première fois seulement
cp .env.example .env                # puis renseigner les identifiants
export $(grep -v '^#' .env | xargs)
npm run dev                         # serveur sur http://localhost:8080
npm run cli -- job.json             # ou exécution directe d'un JSON, sans serveur
```

```bash
curl -X POST http://localhost:8080/run -H 'content-type: application/json' -d @job.json
```

Pour une première validation sur le vrai site, utiliser `"dryRun": true` avec `HEADLESS=false` : le bot fait tout sauf la signature finale (attention, les étapes 5 et 9 créent et envoient bien un dossier côté Consuel).

## Tests

```bash
npm test
```

- tests unitaires : analyse d'adresse, règles métier, validation du JSON ;
- test de bout en bout contre un faux site local (`test/mock-site.ts`) qui reproduit les sélecteurs du workflow : hybride ou non, dry run, commune introuvable, protection contre les URL internes.

Le faux site ne remplace pas un essai sur le vrai site (voir « Points à valider »).

## Déploiement sur Google Cloud Run

La configuration de déploiement reprend celle de [inpi-bot](https://github.com/orionenergies/inpi-bot) : build distant via `--source .` (Cloud Build + `Dockerfile`), authentification par `GCP_SA_KEY` ou `gcloud auth login`, mode `--preserve-env`, IP de sortie fixe via Cloud NAT. Différences : région `europe-west9` (Paris) et secrets dans Secret Manager au lieu de variables d'environnement en clair.

```bash
export GCP_PROJECT=orion-bots
export CONSUEL_LOGIN='…' CONSUEL_PASSWORD='…'   # créés / mis à jour dans Secret Manager (consuel-login, consuel-password)
export API_KEY='…'                               # clé x-api-key, secret partagé `api-key` (créé s'il manque, jamais écrasé)
npm run deploy:cloudrun                          # ou ./scripts/deploy-cloud-run.sh
```

Redéploiement du code seul, sans toucher aux secrets ni aux variables du service live (le service doit déjà avoir le secret `API_KEY`, sinon `/run` répond 503) :

```bash
GCP_PROJECT=orion-bots ./scripts/deploy-cloud-run.sh --preserve-env
```

Variables du script :

| Variable                | Défaut         | Rôle                                                                                  |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `GCP_PROJECT`           | projet gcloud  | Projet GCP (`orion-bots` en prod)                                                      |
| `GCP_REGION`            | `europe-west9` | Région Cloud Run (Paris)                                                               |
| `SERVICE_NAME`          | `consuel-bot`  | Nom du service                                                                         |
| `STATIC_EGRESS_IP`      | `false`        | `true` : IP de sortie fixe (Cloud NAT), voir ci-dessous                                |
| `ALLOW_UNAUTHENTICATED` | `true`         | `true` : service public (appelable depuis Make.com, comme inpi-bot). `false` : privé, jeton Google requis |
| `API_KEY`               |                | Clé `x-api-key`, utilisée seulement si le secret `api-key` n'existe pas encore             |
| `GCP_SA_KEY`            |                | JSON d'un compte de service (agents Cloud), sinon `gcloud auth login`                  |

Paramètres retenus : 2 Gio de mémoire, 2 vCPU, timeout 900 s, `--concurrency 1`, `--max-instances 1` (le compte Consuel est partagé : deux runs simultanés se marcheraient dessus), `--min-instances 0`, service public (`--allow-unauthenticated`) pour être appelé depuis Make.com.

### IP de sortie fixe (Cloud NAT)

À utiliser si `/diag` indique `bloque: true`, ou si le Consuel doit autoriser une IP :

```bash
STATIC_EGRESS_IP=true npm run deploy:cloudrun
# ou, sur un service déjà déployé :
GCP_PROJECT=orion-bots ./scripts/setup-cloudrun-static-egress.sh
```

Le script crée (de façon idempotente) l'adresse `consuel-egress-ip`, le routeur `consuel-router` et le NAT `consuel-nat` sur le réseau `default`, puis passe le service en Direct VPC egress `all-traffic`. L'IP est affichée à la fin.

### Localisation de l'IP de sortie

Cloud Run n'a pas d'IP de sortie fixe par défaut : elle est choisie dans les plages Google de la région du service. Avec `europe-west9`, ces plages sont déclarées en France (Paris) dans le [geofeed publié par Google](https://www.gstatic.com/ipranges/cloud_geofeed) (`34.155.0.0/16`, `34.163.0.0/16`, `34.1.0.0/20`, etc.). L'IP réservée par `STATIC_EGRESS_IP=true` est une adresse régionale `europe-west9`, donc dans ces plages. Elle reste une IP de datacenter Google : les bases de géolocalisation tierces peuvent mettre du temps à refléter le geofeed. À titre de comparaison, inpi-bot est en `europe-west1` (IP `34.62.155.159`, Belgique). Vérification après déploiement : `GET /diag` (protégé par `x-api-key` en production) renvoie `egressIp`.

### Clé d'API

Comme pour les autres bots Orion, `/run` et `/diag` exigent l'en-tête `x-api-key` quand `NODE_ENV=production` (valeur par défaut de l'image Docker) :

| Cas                              | Réponse |
| -------------------------------- | ------- |
| En-tête absent                   | `401`   |
| Clé invalide                     | `403`   |
| `API_KEY` non configurée (prod)  | `503` : le service refuse tout plutôt que de rester ouvert |

`/healthz` reste ouvert. La clé vient du secret Secret Manager `api-key`, partagé entre les bots du projet : le script le crée à partir de `API_KEY` s'il n'existe pas, et ne le modifie jamais ensuite. En local (`NODE_ENV` différent de `production`), l'authentification est désactivée.

### Appel depuis Make.com

Module HTTP « Make a request » :

- **URL** : `<URL du service>/run` (affichée en fin de déploiement)
- **Méthode** : `POST`
- **Headers** : `Content-Type: application/json`, `x-api-key: <API_KEY>`
- **Body** : le JSON décrit dans « Entrée » (`plantCode`, `injectedPower`, `address`, `projectType`, `siteName`, `spv`, `dre`, et `debug: true` pour recevoir la vidéo)
- **Timeout** : au moins 900 s (un run dure plusieurs minutes)

Appel équivalent en ligne de commande :

```bash
curl -X POST "$SERVICE_URL/run" -H "x-api-key: $API_KEY" -H 'content-type: application/json' -d @job.json
```

Pour repasser le service en privé : `ALLOW_UNAUTHENTICATED=false ./scripts/deploy-cloud-run.sh --preserve-env`, puis appeler avec `-H "Authorization: Bearer $(gcloud auth print-identity-token)"` en plus de `x-api-key`.

Les logs sont en JSON (`severity`, `message`), lisibles dans Cloud Logging.

## Points à valider avant la mise en production

- **Blocage possible par le WAF.** L'API de monespaceconsuel.com répond `403 Attack detected` depuis l'IP d'un datacenter AWS (testé depuis l'environnement de développement), ce qui empêche la connexion. Il faut vérifier que les IP de sortie de Cloud Run (France, `europe-west9`) passent, via `/diag`. Sinon, router la sortie par Cloud NAT avec une IP statique (`STATIC_EGRESS_IP=true`) et demander au Consuel de l'autoriser.
- **Sélecteurs et listes Ionic.** Les sélecteurs viennent de la description du workflow et n'ont pas pu être testés sur le vrai site connecté. Les points marqués « (Ajustement ?) » dans le besoin sont les plus fragiles : la sélection de la commune, la cascade Autre > Agricole > Stockage et le choix de la dernière option de production. En cas d'échec, la réponse 500 indique l'étape et une capture d'écran est enregistrée dans `SCREENSHOT_DIR`.
- **Format de la puissance.** Si le champ est de type `number`, la valeur est envoyée avec un point, sinon avec une virgule. L'unité (kW, kVA...) n'est pas convertie : `injectedPower` doit déjà être dans l'unité attendue par le formulaire.
- **Mot de passe.** Le mot de passe a été partagé en clair dans la demande initiale : il est conseillé de le changer avant la mise en production.

## Sécurité

- Le DRE n'est téléchargé que depuis une URL http(s) publique (adresses privées, loopback et serveur de métadonnées GCP refusés, redirections revérifiées, taille limitée à 25 Mo par défaut).
- Le service Cloud Run est public pour être appelé depuis Make.com : l'accès à `/run` et `/diag` est protégé par la clé d'API (en-tête `x-api-key`, comparaison à temps constant). Ne jamais écrire la clé dans le code ; elle reste dans Secret Manager.
