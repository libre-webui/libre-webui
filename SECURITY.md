# Security Policy

Libre WebUI treats vulnerability reports as confidential until a fix and a
coordinated disclosure plan are ready.

## Supported versions

Security fixes are made on the `dev` branch and released from `main`. Only the
latest published release receives security updates. Upgrade to the newest
release before reporting a problem that may already have been corrected.

## Report a vulnerability privately

Do not open a public issue, discussion, or pull request for a suspected
vulnerability. Use either:

- [GitHub private vulnerability reporting](https://github.com/libre-webui/libre-webui/security/advisories/new)
- Email: [security@kroonen.ai](mailto:security@kroonen.ai)

Include the affected version or commit, deployment model, reproduction steps,
security impact, and any suggested mitigation. Remove secrets, personal data,
access tokens, and data belonging to other people from the report.

We aim to acknowledge reports within three business days. We will keep the
reporter informed while we reproduce, remediate, test, release, and coordinate
disclosure. Please allow a reasonable remediation window before publishing
details.

## Scope and trust boundaries

Reports about authentication, authorization, secret handling, cross-user data
access, request forgery, injection, unsafe file processing, and sandbox escapes
are in scope.

Libre WebUI's Work feature can deliberately run administrator-approved commands
inside task containers. Local repository Compose files mount the Docker socket
by default; the private remote profile requires its explicit Work override.
Either arrangement grants the application root-equivalent control of that
Docker host. Behavior that requires a trusted administrator to intentionally
run a command is not, by itself, a vulnerability. Escaping the documented Work
authorization or isolation boundaries is in scope.

## CI security findings and triage

Every push to `dev` or `main` and every pull request runs the normal Security
workflow. It performs an npm dependency audit, Semgrep OWASP static analysis,
repository secret scanning, source and runtime-image SBOM generation, and a
high/critical container vulnerability scan. GitHub's configured
JavaScript/TypeScript CodeQL default setup runs independently. The dependency
audit fails on
moderate-or-higher advisories. The container gate fails on high or critical
findings that have a published fix. Scanner reports and CycloneDX SBOMs are
retained as workflow artifacts for 30 days; SARIF findings are also uploaded to
GitHub code scanning when the event has permission to do so.

Treat a secret finding as an incident, not an ordinary false-positive queue:
revoke or rotate the credential first, remove it from the current tree and Git
history as appropriate, and notify affected operators through a private
channel. Never paste the value into an issue, pull request, suppression file,
or CI log.

The pull-request owner must disposition every other blocking finding as one of:

- **fixed**, with the correcting commit and a regression test when behavior is
  involved;
- **false positive**, with evidence that identifies the exact rule and safe
  code or package; or
- **accepted risk**, with a named owner, narrowly scoped suppression,
  compensating control, and an expiry date.

Do not add blanket scanner exclusions or lower a workflow severity threshold to
make a build green. Prefer updating or overriding a vulnerable dependency. Any
unavoidable Trivy suppression must identify the specific vulnerability or rule
and record its owner, rationale, and expiry in the same pull request. Critical
findings are release-blocking and require immediate triage; high findings are
release-blocking and should be resolved within seven days; moderate dependency
findings should be resolved within 30 days. Re-open an accepted risk when its
expiry, package version, container base, or affected code changes.

## Safe harbor

Good-faith research that avoids privacy violations, data destruction, service
disruption, persistence, and access beyond what is necessary to demonstrate the
issue is welcome. We will not pursue legal action for research consistent with
this policy. Stop testing and report immediately if you encounter sensitive or
personal data.
