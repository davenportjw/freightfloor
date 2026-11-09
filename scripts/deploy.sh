#!/usr/bin/env bash
# Build site/lobby/loadtest images tagged with the short git SHA, pin that tag for Terraform,
# and apply. Terraform is the only thing that changes running images; avoid
# `gcloud run services update --image`, which makes the next plan roll images back.
#
# Usage: scripts/deploy.sh            # build + plan + apply (prompts)
#        SKIP_BUILD=1 scripts/deploy.sh   # re-pin an already-built tag (IMAGE_TAG=<sha>)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROJECT_ID="${PROJECT_ID:-$(sed -nE 's/^project_id[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' infra/terraform.tfvars 2>/dev/null)}"
[[ -n "$PROJECT_ID" ]] || { echo "Set project_id in infra/terraform.tfvars or PROJECT_ID." >&2; exit 1; }

if [[ -z "${SKIP_BUILD:-}" ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Working tree has uncommitted changes; commit first so the image tag matches the code." >&2
    exit 1
  fi
  IMAGE_TAG="$(git rev-parse --short HEAD)"
  echo "==> Building images :${IMAGE_TAG}"
  gcloud builds submit --config=cloudbuild.yaml --project="$PROJECT_ID" \
    --service-account="projects/${PROJECT_ID}/serviceAccounts/warehouse-cloudbuild@${PROJECT_ID}.iam.gserviceaccount.com" \
    --substitutions="_TAG=${IMAGE_TAG}" .
else
  : "${IMAGE_TAG:?Set IMAGE_TAG when SKIP_BUILD=1}"
fi

echo "==> Pinning image_tag = ${IMAGE_TAG} in infra/image_tag.auto.tfvars (gitignored)"
printf 'image_tag = "%s"\n' "$IMAGE_TAG" > infra/image_tag.auto.tfvars

terraform -chdir=infra fmt -check
terraform -chdir=infra validate
terraform -chdir=infra apply
