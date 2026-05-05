# Codex Skills for `voice-first`

This repo uses the official `ComposioHQ/awesome-codex-skills` skill layout instead of the previous ECC local prompt bundle.

## How to use skills in this repo

- Install the skills you want into `$CODEX_HOME/skills` (usually `~/.codex/skills`) with `scripts/install-awesome-codex-skills.sh`.
- Restart Codex after installing or updating skills.
- Invoke installed skills naturally in prompts, for example:
  - `Use the create-plan skill before making code changes.`
  - `Use the codebase-migrate skill for a larger refactor.`
  - `Use the changelog-generator skill after shipping a user-visible change.`

## Recommended skills for this repo

- `create-plan` — plan before implementation
- `codebase-migrate` — guide larger structural refactors
- `changelog-generator` — summarize user-facing changes

Prefer project-native build/test commands when a skill asks to validate work.
