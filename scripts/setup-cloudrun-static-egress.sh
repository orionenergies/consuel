#!/usr/bin/env bash
# Réserve une IP statique + Cloud NAT et branche Cloud Run (egress all-traffic).
# Usage :
#   export GCP_PROJECT=orion-bots GCP_REGION=europe-west9
#   ./scripts/setup-cloudrun-static-egress.sh
#
# Ressources créées (idempotent) :
#   - compute address  : consuel-egress-ip
#   - compute router   : consuel-router
#   - Cloud NAT        : consuel-nat
#   - Cloud Run update : network=default, subnet=default, vpc-egress=all-traffic
set -euo pipefail

export PATH="${PATH}:/tmp/google-cloud-sdk/bin"

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
: "${PROJECT:?Définir GCP_PROJECT}"
REGION="${GCP_REGION:-europe-west9}"
SERVICE="${SERVICE_NAME:-consuel-bot}"
NETWORK="${VPC_NETWORK:-default}"
SUBNET="${VPC_SUBNET:-default}"
ADDRESS_NAME="${NAT_ADDRESS_NAME:-consuel-egress-ip}"
ROUTER_NAME="${NAT_ROUTER_NAME:-consuel-router}"
NAT_NAME="${NAT_NAME:-consuel-nat}"

if [[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" && -f "${GOOGLE_APPLICATION_CREDENTIALS}" ]]; then
  gcloud auth activate-service-account --key-file="${GOOGLE_APPLICATION_CREDENTIALS}" --quiet >/dev/null
fi
gcloud config set project "${PROJECT}" --quiet >/dev/null

gcloud services enable compute.googleapis.com run.googleapis.com --project="${PROJECT}" >/dev/null

if ! gcloud compute addresses describe "${ADDRESS_NAME}" --region="${REGION}" --project="${PROJECT}" >/dev/null 2>&1; then
  gcloud compute addresses create "${ADDRESS_NAME}" --region="${REGION}" --project="${PROJECT}"
fi
STATIC_IP="$(gcloud compute addresses describe "${ADDRESS_NAME}" --region="${REGION}" --project="${PROJECT}" --format='value(address)')"
echo "IP statique : ${STATIC_IP}"

if ! gcloud compute routers describe "${ROUTER_NAME}" --region="${REGION}" --project="${PROJECT}" >/dev/null 2>&1; then
  gcloud compute routers create "${ROUTER_NAME}" \
    --network="${NETWORK}" \
    --region="${REGION}" \
    --project="${PROJECT}"
fi

if ! gcloud compute routers nats describe "${NAT_NAME}" --router="${ROUTER_NAME}" --region="${REGION}" --project="${PROJECT}" >/dev/null 2>&1; then
  gcloud compute routers nats create "${NAT_NAME}" \
    --router="${ROUTER_NAME}" \
    --region="${REGION}" \
    --nat-external-ip-pool="${ADDRESS_NAME}" \
    --nat-all-subnet-ip-ranges \
    --project="${PROJECT}"
fi

gcloud run services update "${SERVICE}" \
  --region="${REGION}" \
  --project="${PROJECT}" \
  --network="${NETWORK}" \
  --subnet="${SUBNET}" \
  --vpc-egress=all-traffic

echo
echo "OK : egress Cloud Run via NAT. IP de sortie (à communiquer au Consuel) : ${STATIC_IP}"
echo "Note : IP Google Cloud (datacenter), stable mais pas une IP résidentielle."
gcloud run services describe "${SERVICE}" --region="${REGION}" --project="${PROJECT}" \
  --format='value(status.latestReadyRevisionName,status.url)'
