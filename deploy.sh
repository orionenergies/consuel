#!/usr/bin/env bash
# Déploie le bot sur Cloud Run (build via Cloud Build à partir du Dockerfile).
#
# Prérequis : gcloud authentifié, projet sélectionné, secrets déjà créés :
#   printf '%s' "<login>"    | gcloud secrets create consuel-login    --data-file=-
#   printf '%s' "<password>" | gcloud secrets create consuel-password --data-file=-
#
# Variables :
#   SERVICE          nom du service (défaut : consuel-bot)
#   REGION           région (défaut : europe-west9, Paris)
#   STATIC_EGRESS_IP=true  crée une IP de sortie fixe (Cloud NAT) à faire autoriser par le Consuel
set -euo pipefail

SERVICE="${SERVICE:-consuel-bot}"
REGION="${REGION:-europe-west9}"
STATIC_EGRESS_IP="${STATIC_EGRESS_IP:-false}"

EXTRA_ARGS=()
if [[ "$STATIC_EGRESS_IP" == "true" ]]; then
  gcloud compute addresses describe consuel-egress-ip --region "$REGION" >/dev/null 2>&1 \
    || gcloud compute addresses create consuel-egress-ip --region "$REGION"
  gcloud compute routers describe consuel-router --region "$REGION" >/dev/null 2>&1 \
    || gcloud compute routers create consuel-router --network default --region "$REGION"
  gcloud compute routers nats describe consuel-nat --router consuel-router --region "$REGION" >/dev/null 2>&1 \
    || gcloud compute routers nats create consuel-nat --router consuel-router --region "$REGION" \
         --nat-external-ip-pool consuel-egress-ip --nat-all-subnet-ip-ranges
  EXTRA_ARGS+=(--network default --subnet default --vpc-egress all-traffic)
  echo "IP de sortie fixe à communiquer au Consuel :"
  gcloud compute addresses describe consuel-egress-ip --region "$REGION" --format='value(address)'
fi

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
  --set-env-vars "HEADLESS=true,RUN_TIMEOUT_MS=840000" \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
