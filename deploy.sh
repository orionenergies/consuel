#!/usr/bin/env bash
# Déploie le bot sur Cloud Run (build via Cloud Build à partir du Dockerfile).
# Prérequis : gcloud authentifié, projet sélectionné, secrets déjà créés :
#   printf '%s' "<login>"    | gcloud secrets create consuel-login    --data-file=-
#   printf '%s' "<password>" | gcloud secrets create consuel-password --data-file=-
set -euo pipefail

SERVICE="${SERVICE:-consuel-bot}"
REGION="${REGION:-europe-west9}"

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --memory 2Gi \
  --cpu 1 \
  --timeout 900 \
  --concurrency 1 \
  --max-instances 1 \
  --min-instances 0 \
  --no-allow-unauthenticated \
  --set-secrets "CONSUEL_LOGIN=consuel-login:latest,CONSUEL_PASSWORD=consuel-password:latest" \
  --set-env-vars "HEADLESS=true,RUN_TIMEOUT_MS=840000"
