---
description: How to automatically summarize recent changes and update README and CHANGELOG
---

# Update Documentation and Changelog Workflow

When asked to run the `/update-docs` workflow or summarize recent changes into the documentation, follow these steps:

## 1. Gather Recent Work Context

1. **Review Task History**: Check the current `task.md`, `walkthrough.md`, and any `implementation_plan.md` in the agent's brain directory to understand exactly what features, bug fixes, and architectural changes were recently made.
2. **Identify Key Features**: Group the changes into logical categories:
   - **New Features** (e.g. new settings, new endpoints, new UI components)
   - **Bug Fixes** (e.g. layout fixes, crash resolutions, cross-platform fixes)
   - **Security/Performance** (e.g. auth gating, new optimizations)

## 2. Update the CHANGELOG.md

1. If `CHANGELOG.md` does not exist in the root directory, create it.
2. Under the `## [Unreleased]` section (or create a new version header if releasing):
   - Add a `### Added` section for new features.
   - Add a `### Fixed` section for bug fixes.
   - Summarize the recent work into bullet points, referencing GitHub issue numbers if applicable (e.g. `Fix Windows server startup crash (Issue #98)`).

## 3. Update README.md (and translated versions like README_pt-BR.md)

1. **Main Features List**: If a notable new feature was added (like a new security setting or API option), add it to the feature list section.
2. **Configuration/Settings**: If any new environment variables or dashboard settings were introduced, document them in the configuration or usage sections so users know how to enable them.
3. If there are translated versions of the README (like Portuguese), ensure those are updated equivalently.

## 4. Update Technical Docs (docs/ directory)

1. Use `list_dir` to inspect the `docs/` folder.
2. Determine which technical documents need updates. For example:
   - If an API changed, update `docs/API_REFERENCE.md` or similar.
   - If security settings changed, update `docs/SECURITY.md` or `docs/CONFIGURATION.md`.
3. Read the relevant files, update their content using `replace_file_content`, and briefly explain how the new feature works under the hood.

## 5. Verify the Updates

Ensure all markdown files are properly formatted and no existing sections were accidentally deleted. Present the changes to the user showing which files were updated.
