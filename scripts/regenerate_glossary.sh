#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PDF_URL="https://tc.canada.ca/sites/default/files/2020-08/AC-100-001_Issue07.pdf"
PDF_PATH="${ROOT_DIR}/AC-100-001_Issue07.pdf"
TXT_PATH="${ROOT_DIR}/glossary.txt"

curl -L "${PDF_URL}" -o "${PDF_PATH}"
node "${ROOT_DIR}/node_modules/pdf-parse/bin/cli.mjs" text "${PDF_PATH}" --output "${TXT_PATH}"
node "${ROOT_DIR}/scripts/build_pilot_glossary.cjs"
rm -f "${PDF_PATH}" "${TXT_PATH}"
