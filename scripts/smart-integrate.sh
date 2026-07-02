#!/bin/bash

# Smart integration script for zccusage
# Handles the fact that upstream uses apps/ccusage while we use apps/zccusage

set -euo pipefail
IFS=$'\n\t'

UPSTREAM_COMMIT=${1:-"upstream/main"}
CURRENT_BRANCH=$(git branch --show-current)
INTEGRATION_BRANCH="integrate-upstream-$(date +%Y%m%d-%H%M%S)"

echo "🔄 Starting smart upstream integration..."
echo "Current branch: $CURRENT_BRANCH"
echo "Integration branch: $INTEGRATION_BRANCH"

cd "$(git rev-parse --show-toplevel)"

echo "🔍 Validating integration environment..."
# Validate pnpm is available
if ! command -v pnpm &> /dev/null; then
  echo "❌ pnpm not found. Please install pnpm first."; exit 1
fi
# Validate git repo status
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "❌ Not a git repository."; exit 1
fi

# Ensure clean working tree
if ! git diff-index --quiet HEAD --; then
  echo "❌ Uncommitted changes present. Commit/stash before running."; exit 1
fi

# Create integration branch
git checkout -b "$INTEGRATION_BRANCH"

# Fetch latest upstream
git fetch upstream

# Temporarily rename our zccusage to match upstream structure
echo "📦 Temporarily restructuring to match upstream..."
if [ ! -d "apps/zccusage" ]; then
  echo "❌ apps/zccusage not found."; exit 1i
git mv apps/zccusage apps/ccusage-temp

# Now merge upstream
echo "🔄 Merging upstream changes..."
if git merge "$UPSTREAM_COMMIT" --no-edit; then
    echo "✅ Merge completed successfully!"

    # Move upstream ccusage to zccusage and merge with our changes
    echo "🔄 Converting upstream structure to our structure..."

    # If upstream ccusage exists, move it aside first
    if [ -d "apps/ccusage" ]; then
        git mv apps/ccusage apps/upstream-ccusage
    fi

    # Move our temp back to zccusage
    git mv apps/ccusage-temp apps/zccusage

    # Commit the structure change
    git commit -m "chore: restore zccusage structure" --no-verify

    # If upstream ccusage existed, merge it into our zccusage
    if [ -d "apps/upstream-ccusage" ]; then
        echo "🔄 Merging upstream ccusage changes into zccusage..."

        # Create a temporary branch to merge the upstream ccusage
        git checkout -b temp-merge-ccusage
        git merge "$INTEGRATION_BRANCH" --no-edit

        # Move upstream ccusage content to zccusage
        cp -a apps/upstream-ccusage/. apps/zccusage/
        rm -rf apps/upstream-ccusage

        # Add all changes
        git add .
        git commit -m "feat: merge upstream ccusage into zccusage"  --no-verify

        # Go back to integration branch
        git checkout "$INTEGRATION_BRANCH"
        git merge temp-merge-ccusage --no-edit
        git branch -D temp-merge-ccusage
    fi

    echo "🎉 Integration completed!"
    echo "📋 Next steps:"
    echo "   1. Review changes: git show --stat"
    echo "   2. Test thoroughly: pnpm test"
    echo "   3. Create PR: gh pr create"

else
    echo "❌ Merge conflicts detected!"
    echo "🔧 Please resolve conflicts manually:"
    echo "   1. git status"
    echo "   2. Resolve conflicted files"
    echo "   3. git add ."
    echo "   4. git commit"
    echo ""
    echo "💡 After resolving conflicts:"
    echo "   1. Restore zccusage structure:"
    echo "      - Move apps/ccusage-temp -> apps/zccusage"
    echo "      - Remove apps/ccusage if it exists"
fi