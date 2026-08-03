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

## Safe harbor

Good-faith research that avoids privacy violations, data destruction, service
disruption, persistence, and access beyond what is necessary to demonstrate the
issue is welcome. We will not pursue legal action for research consistent with
this policy. Stop testing and report immediately if you encounter sensitive or
personal data.
