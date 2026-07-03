#!/bin/bash

echo "🔍 Vérification des dépendances manquantes..."
echo "============================================="
cd apps/zccusage

# Lister tous les imports depuis les fichiers TypeScript
echo "Imports trouvés:"
find src -name "*.ts" -exec grep -h "from '" {} \; | \
  grep -v "from '\." | \
  grep -v "from '@zccusage" | \
  sed "s/.*from '\([^']*\)'.*/\1/" | \
  sort -u > /tmp/imports.txt

# Lister les dépendances du package.json
grep -E '^\s*"[^"]+": "' package.json | \
  sed 's/.*"\([^"]*\)".*/\1/' | \
  sort -u > /tmp/deps.txt

echo ""
echo "❌ Dépendances MANQUANTES (utilisées mais non listées):"
echo "========================================================"
comm -23 <(sort /tmp/imports.txt) <(sort /tmp/deps.txt) | grep -v node:

rm -f /tmp/imports.txt /tmp/deps.txt
