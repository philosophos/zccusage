#!/bin/bash
set -e

echo "🔍 VÉRIFICATION DES DÉPENDANCES - zccusage"
echo "================================================="
echo ""

# Vérifier que chaque import a sa dépendance correspondante
cd apps/zccusage

# Lister toutes les imports depuis les fichiers source
echo "📋 Vérification des imports dans le code source..."
echo "==================================================="

# Extraire tous les imports et vérifier s'ils sont dans package.json
for file in $(find src -name "*.ts" -type f); do
    # Extraire les imports
    grep -E "^import.*from ['\"]([^'\"])([^'\"]*)['\"]" "$file" 2>/dev/null | \
    while IFS="'"" read -r line; do
        # Extraire le nom du package
        if [[ $line =~ from[[:space:]]+['\"]([^'\"]+)['\"] ]]; then
            package="${BASH_REMATCH[1]}"
            # Vérifier si c'est un package externe (ne commence pas par . ou @zccusage)
            if [[ ! $package =~ ^\. ]] && [[ ! $package =~ ^@zccusage ]]; then
                # Vérifier si la dépendance est dans package.json
                if ! grep -q "\"$package\"" package.json; then
                    echo "❌ MANQUANT: $package (utilisé dans $file)"
                fi
            fi
        fi
    done
done

echo ""
echo "✅ Vérification terminée !"
echo ""
echo "📦 Dépendances actuelles dans package.json:"
grep -E '"[^"]+": "(catalog:|workspace:)' package.json | grep -v '"@zccusage' | head -20
