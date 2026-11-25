#!/usr/bin/env bash
# Déploie consuel-bot sur Cloud Run (build distant via --source, pas de Docker local requis).
# Config reprise de inpi-bot (scripts/deploy-cloud-run.sh), région Paris par défaut.
#
# Prérequis :
#   gcloud auth login   (ou GOOGLE_APPLICATION_CREDENTIALS=sa.json / GCP_SA_KEY)
#
# Premier déploiement ou rotation des secrets :
#   export GCP_PROJECT=orion-bots
#   export CONSUEL_LOGIN=…  CONSUEL_PASSWORD=…     # stockés dans Secret Manager
#   ./scripts/deploy-cloud-run.sh
#
# Redéploiement du code seul (secrets et variables du service live conservés) :
#   export GCP_PROJECT=orion-bots
#   ./scripts/deploy-cloud-run.sh --preserve-env
#
# Variables optionnelles :
#   GCP_REGION=europe-west9         (Paris, défaut)
#   SERVICE_NAME=consuel-bot
#   STATIC_EGRESS_IP=true           IP de sortie fixe (Cloud NAT), voir setup-cloudrun-static-egress.sh
#   ALLOW_UNAUTHENTICATED=true      service public (ex. appel depuis Make.com), privé par défaut
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PRESERVE_ENV=0
for arg in "$@"; do
  case "$arg" in
    --preserve-env) PRESERVE_ENV=1 ;;
    -h|--help)
      sed -n '2,22p' "$0"
      exit 0
      ;;
    *)
      echo "Argument inconnu : $arg (options : --preserve-env)" >&2
      exit 1
      ;;
  esac
done

export PATH="${PATH}:/tmp/google-cloud-sdk/bin"

if [[ -n "${GCP_SA_KEY:-}" && -z "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]]; then
  SA_FILE="${TMPDIR:-/tmp}/gcp-sa-consuel.json"
  printf '%s\n' "$GCP_SA_KEY" > "$SA_FILE"
  chmod 600 "$SA_FILE"
  export GOOGLE_APPLICATION_CREDENTIALS="$SA_FILE"
  gcloud auth activate-service-account --key-file="$SA_FILE" --quiet
fi

GCP_PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
: "${GCP_PROJECT:?Définir GCP_PROJECT}"
GCP_REGION="${GCP_REGION:-europe-west9}"
SERVICE_NAME="${SERVICE_NAME:-consuel-bot}"
STATIC_EGRESS_IP="${STATIC_EGRESS_IP:-false}"
ALLOW_UNAUTHENTICATED="${ALLOW_UNAUTHENTICATED:-false}"

gcloud config set project "$GCP_PROJECT" --quiet

gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project "$GCP_PROJECT"

upsert_secret() {
  local name="$1" value="$2"
  if ! gcloud secrets describe "$name" --project "$GCP_PROJECT" >/dev/null 2>&1; then
    gcloud secrets create "$name" --replication-policy=automatic --project "$GCP_PROJECT"
  fi
  printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --project "$GCP_PROJECT" >/dev/null
  echo "Secret $name mis à jour."
}

grant_secret_access() {
  local project_number runtime_sa name
  project_number="$(gcloud projects describe "$GCP_PROJECT" --format='value(projectNumber)')"
  runtime_sa="${RUNTIME_SERVICE_ACCOUNT:-${project_number}-compute@developer.gserviceaccount.com}"
  for name in consuel-login consuel-password; do
    gcloud secrets add-iam-policy-binding "$name" \
      --project "$GCP_PROJECT" \
      --member "serviceAccount:${runtime_sa}" \
      --role roles/secretmanager.secretAccessor >/dev/null
  done
}

if [[ "$PRESERVE_ENV" -eq 0 ]]; then
  if [[ -n "${CONSUEL_LOGIN:-}" && -n "${CONSUEL_PASSWORD:-}" ]]; then
    upsert_secret consuel-login "$CONSUEL_LOGIN"
    upsert_secret consuel-password "$CONSUEL_PASSWORD"
  else
    for name in consuel-login consuel-password; do
      if ! gcloud secrets describe "$name" --project "$GCP_PROJECT" >/dev/null 2>&1; then
        echo "Secret $name introuvable : exporter CONSUEL_LOGIN et CONSUEL_PASSWORD, ou créer les secrets au préalable." >&2
        exit 1
      fi
    done
  fi
  grant_secret_access
fi

AUTH_FLAG="--no-allow-unauthenticated"
if [[ "$ALLOW_UNAUTHENTICATED" == "true" ]]; then
  AUTH_FLAG="--allow-unauthenticated"
fi

CONFIG_ARGS=()
if [[ "$PRESERVE_ENV" -eq 1 ]]; then
  echo "Mode --preserve-env : conserve secrets et variables d'environnement du service live."
else
  CONFIG_ARGS+=(
    --set-secrets "CONSUEL_LOGIN=consuel-login:latest,CONSUEL_PASSWORD=consuel-password:latest"
    --set-env-vars "HEADLESS=true,RUN_TIMEOUT_MS=840000,ACTION_TIMEOUT_MS=45000"
  )
fi

echo "Déploiement Cloud Run : $SERVICE_NAME ($GCP_REGION)…"

gcloud run deploy "$SERVICE_NAME" \
  --project "$GCP_PROJECT" \
  --region "$GCP_REGION" \
  --source . \
  --platform managed \
  "$AUTH_FLAG" \
  --memory 2Gi \
  --cpu 2 \
  --timeout 900 \
  --concurrency 1 \
  --min-instances 0 \
  --max-instances 1 \
  ${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"}

if [[ "$STATIC_EGRESS_IP" == "true" ]]; then
  GCP_PROJECT="$GCP_PROJECT" GCP_REGION="$GCP_REGION" SERVICE_NAME="$SERVICE_NAME" \
    "$ROOT/scripts/setup-cloudrun-static-egress.sh"
fi

URL="$(gcloud run services describe "$SERVICE_NAME" \
  --project "$GCP_PROJECT" \
  --region "$GCP_REGION" \
  --format='value(status.url)')"

echo
echo "Service déployé : ${URL}"
echo "Health  : ${URL}/healthz"
echo "Diag    : ${URL}/diag   (IP de sortie + blocage éventuel du WAF Consuel)"
echo "Requête : POST ${URL}/run"
echo
if [[ "$ALLOW_UNAUTHENTICATED" == "true" ]]; then
  echo "curl -sS -X POST '${URL}/run' -H 'Content-Type: application/json' -d @job.json"
else
  echo "curl -sS -X POST '${URL}/run' -H \"Authorization: Bearer \$(gcloud auth print-identity-token)\" -H 'Content-Type: application/json' -d @job.json"
fi
