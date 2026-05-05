#!/usr/bin/env bash
set -euo pipefail

REPO_SLUG="ComposioHQ/awesome-codex-skills"
REPO_URL="https://github.com/${REPO_SLUG}.git"
REPO_REF="${AWESOME_CODEX_SKILLS_REF:-main}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
DEST_DIR="$CODEX_HOME/skills"
LOCAL_INSTALLER="$CODEX_HOME/skills/.system/skill-installer/scripts/install-skill-from-github.py"

usage() {
  cat <<'USAGE'
Usage:
  scripts/install-awesome-codex-skills.sh <skill> [<skill> ...]
  scripts/install-awesome-codex-skills.sh --default

Examples:
  scripts/install-awesome-codex-skills.sh create-plan codebase-migrate
  scripts/install-awesome-codex-skills.sh --default

This installs skills from ComposioHQ/awesome-codex-skills into $CODEX_HOME/skills.
USAGE
}

if [[ $# -eq 0 ]]; then
  usage
  exit 1
fi

skills=()
for arg in "$@"; do
  case "$arg" in
    --default)
      skills+=(create-plan codebase-migrate changelog-generator)
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      skills+=("$arg")
      ;;
  esac
done

# Deduplicate while preserving order.
unique_skills=()
for skill in "${skills[@]}"; do
  skip="false"
  for seen in "${unique_skills[@]:-}"; do
    if [[ "$seen" == "$skill" ]]; then
      skip="true"
      break
    fi
  done
  if [[ "$skip" == "false" ]]; then
    unique_skills+=("$skill")
  fi
done

mkdir -p "$DEST_DIR"

if [[ -f "$LOCAL_INSTALLER" ]]; then
  echo "[awesome-codex-skills] Using local skill-installer at $LOCAL_INSTALLER"
  for skill in "${unique_skills[@]}"; do
    echo "[awesome-codex-skills] Installing $skill"
    python3 "$LOCAL_INSTALLER" --repo "$REPO_SLUG" --path "$skill" --name "$skill"
  done
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  echo "[awesome-codex-skills] git is required when local skill-installer is unavailable." >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "[awesome-codex-skills] Local skill-installer not found; cloning $REPO_SLUG@$REPO_REF"
git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$TEMP_DIR/repo" >/dev/null 2>&1

for skill in "${unique_skills[@]}"; do
  src="$TEMP_DIR/repo/$skill"
  dest="$DEST_DIR/$skill"
  if [[ ! -d "$src" || ! -f "$src/SKILL.md" ]]; then
    echo "[awesome-codex-skills] Skill not found in upstream repo: $skill" >&2
    exit 1
  fi
  if [[ -e "$dest" ]]; then
    echo "[awesome-codex-skills] Destination already exists: $dest" >&2
    echo "[awesome-codex-skills] Remove it manually first, then rerun the installer." >&2
    exit 1
  fi

  echo "[awesome-codex-skills] Installing $skill"
  mkdir -p "$dest"
  rsync -a --delete --exclude '.DS_Store' "$src/" "$dest/"
done

echo "[awesome-codex-skills] Installed ${#unique_skills[@]} skill(s) into $DEST_DIR"
echo "[awesome-codex-skills] Restart Codex to load new skills."
