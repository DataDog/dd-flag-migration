# Contributing to @datadog/dd-flag-migration

Thank you for your interest in contributing to the Datadog Feature Flag Migration tool! This document provides guidelines for contributing to the project.

## Development Setup

1. **Clone the repo:**

   ```bash
   git clone https://github.com/DataDog/dd-flag-migration.git
   cd dd-flag-migration
   ```

2. **Install dependencies:**

   ```bash
   yarn setup
   ```

   > **Note:** Use `yarn setup` instead of `yarn install`. This project uses [`@lavamoat/allow-scripts`](https://www.npmjs.com/package/@lavamoat/allow-scripts) to protect against supply-chain attacks by blocking all dependency lifecycle scripts by default. `yarn setup` runs `yarn install` and then selectively executes only the explicitly allowed postinstall scripts.

3. **Build:**

   ```bash
   yarn build
   ```

4. **Run tests:**

   ```bash
   yarn test
   ```

5. **Type checking:**

   ```bash
   yarn typecheck
   ```

6. **Linting:**
   ```bash
   yarn lint
   yarn lint:fix  # Auto-fix issues
   ```

Before submitting changes, always run:

```bash
yarn typecheck && yarn lint:fix && yarn test
```

### Adding new packages

When you add a new dependency that has lifecycle scripts (`preinstall`, `install`, or `postinstall`), you'll see this error the next time you run `yarn allow-scripts`:

```
@lavamoat/allow-scripts has detected dependencies without configuration. explicit configuration required.
run "allow-scripts auto" to automatically populate the configuration.
```

To fix this:

1. Inspect the new dependency's install scripts to verify they are safe.
2. Run `yarn allow-scripts auto` to add the new dependency to the allowlist in `package.json`.
3. Run `yarn setup` to re-install with the newly allowed scripts executing.

## Release Process

### Prerequisites

- All tests must pass
- Code must be linted and type-checked
- Changes should be committed and pushed
- Proper GitHub secrets must be configured for npm publishing

### Creating a Release

#### Step 1: Prepare the version

1. **Create a release branch:**
   ```bash
   git checkout -b release/v1.2.3
   ```

2. **Update the version in `package.json`:**
   ```bash
   npm version 1.2.3 --no-git-tag-version
   ```

3. **Commit and push:**
   ```bash
   git add package.json
   git commit -m "👷 chore: bump version to 1.2.3"
   git push origin release/v1.2.3
   ```

4. **Create a PR and merge to `main`.**

#### Step 2: Publish via GitHub Release

**Publishing is fully automated via GitHub workflows!**

1. **Create a GitHub Release:**
   - Go to the GitHub repository
   - Click "Releases" → "Create a new release"
   - Set the tag to match your version (e.g., `v1.2.3`)
   - Target the `main` branch
   - Add release notes describing your changes or use the "Generate Release Notes" button
   - For prereleases, check "Set as a pre-release"
   - Click "Publish release"

2. **Automated Publishing Workflow:**

   The `release.yaml` workflow will automatically trigger and:

   **Validation Phase:**
   - Checks that the GitHub release tag matches the version in `package.json`
   - Fails fast if validation doesn't pass

   **Build and Publish Phase:**
   - Installs dependencies with `yarn install --immutable`
   - Runs lint, type check, build, and tests
   - Publishes to npm with provenance

   **npm Tag Selection:**
   - Production releases get the `latest` tag
   - Prereleases with "preview" in the version get the `preview` tag
   - Other prereleases get the `alpha` tag

### Troubleshooting

#### Common Issues

1. **Version mismatch in GitHub workflow:**
   - Error: "Release tag doesn't match package.json version"
   - Solution: Ensure the GitHub release tag exactly matches `v{version}` format where `{version}` is from `package.json`

2. **Package already published:**
   - The workflow will skip publishing if the version already exists on npm
   - Bump the version and create a new release

#### Manual Publishing (Emergency Only)

If the automated workflow fails and you need to publish manually:

```bash
yarn install --immutable && yarn allow-scripts
yarn lint
yarn typecheck
yarn build
yarn test
npm publish --tag latest
```

## Third-Party Licenses

All third-party dependency licenses are tracked in `LICENSE-3rdparty.csv`. This file is
auto-generated and **must be kept up to date** whenever dependencies change. CI will fail
if it is stale.

### When to update

Re-generate the file whenever you add, remove, or update a dependency in `package.json`.

### Prerequisites

| Requirement                | Details                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| **Python 3.11.12**         | `pyenv install 3.11.12 && pyenv local 3.11.12`                                                   |
| **Go 1.23+**               | Required by `dd-license-attribution`                                                             |
| **dd-license-attribution** | `pip install dd-license-attribution` ([repo](https://github.com/DataDog/dd-license-attribution)) |
| **GITHUB_TOKEN**           | See below                                                                                        |

For more information, see the [dd-license-attribution](https://github.com/DataDog/dd-license-attribution) repository.

### Setting GITHUB_TOKEN

If you already use the [GitHub CLI](https://cli.github.com/), the easiest option is:

```bash
export GITHUB_TOKEN=$(gh auth token)
```

Otherwise, create a fine-grained personal access token with read access to **Contents**
and **Metadata** at https://github.com/settings/personal-access-tokens and export it:

```bash
export GITHUB_TOKEN="github_pat_..."
```

### Generating / updating licenses

```bash
export GITHUB_TOKEN=$(gh auth token)
yarn licenses:generate
```

This overwrites `LICENSE-3rdparty.csv` with the latest data. Commit the result.

### Validating licenses locally

```bash
yarn licenses:validate
```

This checks that every npm package in `yarn.lock` has a corresponding entry in the CSV.
No external tools or tokens are needed — it runs in CI the same way. If it fails, run
`yarn licenses:generate` and commit the result.

## Code Style

- Use TypeScript for all new code
- Follow the existing code style and patterns
- Use the term "targeting filters" or "targeting" in place of "allocations" for customer-facing text
- Run `yarn lint:fix` before committing
- Ensure all tests pass before submitting changes

## Commit Messages

Follow conventional commit format with gitmoji:

- `✨ feat:` for new features
- `🐛 fix:` for bug fixes
- `📝 docs:` for documentation changes
- `🎨 style:` for formatting changes
- `♻️ refactor:` for code refactoring
- `✅ test:` for test changes
- `👷 chore:` for maintenance tasks

Example: `✨ feat: add Eppo flag migration support`

## Getting Help

- Check the [README.md](README.md) for basic project information
- Open an issue on GitHub for bugs or feature requests
