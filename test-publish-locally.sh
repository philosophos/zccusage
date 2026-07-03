#!/bin/bash
# Test local de pnpm pack avant de commit/push

set -e

echo "🧪 Test de pnpm pack en local..."
echo "===================================="

echo ""
echo "1️⃣  Vérification erreurs TypeScript..."
echo "===================================="
cd apps/zccusage
if pnpm typecheck 2>&1 | grep -q "error TS"; then
    echo "❌ Erreurs TypeScript trouvées!"
    pnpm typecheck 2>&1 | grep "error TS"
    exit 1
else
    echo "✅ Aucune erreur TypeScript dans zccusage"
fi
cd ../..

echo ""
echo "2️⃣  Exécution de pnpm pack sure zccusage..."
echo "==============================================="
cd apps/zccusage

# Créer un répertoire temporaire pour tester
TEST_DIR="../../test-pack-$$"
mkdir -p "$TEST_DIR"

# Tester la commande de build et pack
if pnpm run build 2>&1 | tail -20; then
    pnpm pack --pack-destination="$TEST_DIR" > /dev/null 2>&1
    BUILD_EXIT=$?
else
    BUILD_EXIT=1
fi

# Nettoyage
rm -rf "$TEST_DIR"
cd ../..

if [ $BUILD_EXIT -eq 0 ]; then
    echo ""
    echo "✅ ✅ ✅  SUCCÈS ! Le build et pack fonctionnent localement."
    echo ""
    echo "Tu peux maintenant commit et push en toute confiance."
    exit 0
else
    echo ""
    echo "❌ ❌ ❌  ÉCHEC ! Le build ou pack a échoué."
    echo ""
    echo "Corrige les erreurs avant de commit/push."
    exit 1
fi
