# Libre WebUI project instructions

These instructions apply to the entire repository. Use `dev` as the integration
branch and `main` as the production branch.

## Git identity and remotes

- Commit as `Robin Kroonen <rob@kroonen.ai>`.
- Fetch from GitHub with `origin`.
- Push every required branch commit and exact release tag to both remotes:
  - GitHub: `https://github.com/libre-webui/libre-webui.git`
  - GitLab: `https://git.kroonen.ai/libre-webui/libre-webui.git`
- For branch refs, push GitLab first, verify it, then push GitHub and verify the
  pair. Always disable followed tags explicitly:
  `git -c push.followTags=false push <url> HEAD:refs/heads/<branch>`.
- After every push, use `git ls-remote` to prove that both remote refs equal the
  intended local commit. A successful command alone is not sufficient.
- Never force-push, push `--tags`, or move a tag that exists on either remote.
- Preserve unrelated user changes and stop if the worktree is unexpectedly
  dirty or the remote histories have diverged.

## Normal development

1. Work on `dev` unless the user explicitly requests another branch.
2. Keep each logical change in an intentional Conventional Commit.
3. Run tests proportional to the change before committing.
4. Push `dev` explicitly to GitHub and GitLab, verify both SHAs, and inspect the
   GitHub Actions runs for that exact commit.

## Gated patch release

Follow this sequence when asked to merge `dev`, make a patch release, publish
after CI is green, and sync `dev` afterward.

1. **Audit before mutation**
   - Require `git status --porcelain=v1 --untracked-files=all` to be empty and
     confirm the configured author identity.
   - Fetch GitHub branches and tags.
   - Inspect GitHub and GitLab `main`, `dev`, and the proposed tag with
     `git ls-remote`.
   - Confirm the proposed tag is absent locally and on both remotes. Treat the
     tag matching the current package version as the authoritative previous
     production tag, and require it to be reachable from `main`.
   - Confirm the next patch version and review every commit since that tag.
     Stop on an unexpected tag or unrelated divergence.

2. **Promote `dev` locally**
   - Switch to `main` and update it from the verified production ref.
   - Merge `dev` into `main`; prefer `--ff-only` when `main` is already an
     ancestor. Use an explicit merge commit only when the intended histories
     require it.
   - Do not push an intermediate `main` commit that still carries the previous
     package version, because `main` publishes Docker `latest`.

3. **Create the release locally**
   - From a clean `main`, run exactly `npm run release:patch`.
   - The script updates the root, frontend, backend, and lockfile versions,
     writes `CHANGELOG.md`, commits `chore(release): X.Y.Z`, and creates a local
     annotated `vX.Y.Z` tag. It does not push.
   - Review the actual commit/file evidence and rewrite the new changelog
     section when generated notes are vague, duplicated, or incomplete.
   - If the changelog changes after the script, first prove the tag is absent
     from both remotes. Amend the local release commit, then recreate only the
     local annotated tag on the amended commit. Verify `vX.Y.Z^{}` equals
     `HEAD` and that the tagged changelog contains the final notes.

4. **Run the complete local gate**
   - Run `npm run release:check`.
   - Run `npm run test:e2e` because it is not part of `release:check`.
   - Inspect `git show --stat vX.Y.Z`, all package versions, the changelog
     section, tag target, author, branch, and clean worktree.

5. **Gate publication on the release commit**
   - Push the final `main` commit, without the tag, explicitly to GitHub and
     GitLab using the branch command above. Reconfirm after each push that the
     release tag is still absent from both remotes.
   - Verify both `refs/heads/main` values equal local `HEAD`.
   - Wait for every required GitHub workflow for that exact SHA to finish
     successfully: Format & Lint; both Docker architecture builds and manifest
     publication; Electron macOS, Windows, and Linux builds; applicable Helm
     checks when chart files changed; and every code scan present for the SHA.
   - Do not push the tag while any required job is queued, running, skipped
     unexpectedly, cancelled, or failed.
   - A `main` branch push can publish Docker `latest` before the other workflows
     finish. The gate protects the tag, npm package, and GitHub release; report
     this limitation honestly rather than claiming branch artifacts were held.

6. **Publish only the exact release tag**
   - Push only `vX.Y.Z` to GitHub and GitLab; never use `--tags`.
   - Do not use the manual `workflow_dispatch` release path for this gated,
     dual-remote workflow.
   - Verify the tag object and peeled commit on both remotes.
   - Wait for the complete tag-triggered Release workflow: preflight, Electron
     macOS/Windows/Linux builds, and create-release.
   - Verify the GitHub release has the artifacts actually produced by CI:
     macOS arm64 DMG and ZIP, Windows Setup and portable EXE, and Linux AppImage
     and DEB. Require an MSI only if that release workflow produced one.
   - Verify npm `latest` equals `X.Y.Z` and the Docker/main workflow succeeded.
     Do not report Homebrew as updated unless its workflow ran successfully and
     its expected asset name matches the release asset.
   - If a published tag fails, fix forward deliberately. Never rewrite it.

7. **Sync production back to development**
   - Only after every release artifact succeeds, refetch and revalidate both
     remote `dev` refs. Stop if either advanced unexpectedly.
   - Switch to `dev` and merge `main` into it. Prefer `--ff-only` when possible.
   - Push `dev` explicitly to both remotes and verify both SHAs.
   - Wait for the exact dev-SHA Docker and Electron workflows to pass.
   - Verify `main` is an ancestor of `dev`, both remote branch pairs match the
     intended commits, and the worktree is clean.

## Release reporting

Report the release commit, tag object, and peeled tag SHAs, both-remote
verification, local test results, GitHub Actions URLs and conclusions, GitHub
release URL, npm published version, release assets, final branch ancestry, and
worktree state. Never claim success while a required check or publication is
still pending.
