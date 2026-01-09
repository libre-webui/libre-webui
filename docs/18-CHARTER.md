---
sidebar_position: 18
title: "Community Charter"
description: "The foundational principles, governance model, and ethical guidelines for Libre WebUI"
slug: /CHARTER
keywords: [charter, governance, community, ethics, open source, privacy]
---

# Libre WebUI Community & Ethical Charter

_Adopted June 2025 • Maintained by Kroonen AI, Inc._

---

## 1 Mission

Libre WebUI exists to provide a **free, privacy‑respecting, community‑driven interface** for local large‑language‑model workflows.
We pursue simplicity and user sovereignty above growth, hype, or outside investment.

## 2 Core Principles

| Principle               | Commitment                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Freedom**             | Source code will remain licensed under the **Apache License 2.0** in perpetuity.                                                     |
| **Privacy**             | **Zero telemetry**. No analytics, no tracking, no phone‑home code—ever.                                                              |
| **Transparency**        | All decisions, road‑maps, and governance discussions occur in public issues/PRs or recorded community calls.                         |
| **Inclusive Community** | We enforce a strict anti‑harassment policy. All contributors and users are welcome regardless of background, identity, or geography. |
| **Local‑First**         | The default experience never requires cloud services or external APIs. Remote options are opt‑in and clearly marked.                 |
| **No Relicensing**      | This project shall **never** be relicensed to more restrictive terms (e.g., BSD‑3 with CLA, dual‑license, proprietary).              |
| **Ethical Funding**     | We accept donations or grants only if they do not impose control over roadmap, license, or community. **No VC equity.**              |

## 3 Governance Model

1. **Stewardship**
   Kroonen AI, Inc. holds the trademark and domains **as a fiduciary** for the community.
2. **Technical Steering Committee (TSC)**
   _Composition_: minimum 3, maximum 7 active contributors (rotating annually).
   _Responsibilities_: roadmap approval, release signing, Code‑of‑Conduct enforcement.
3. **Decision Process**
   - Consensus‑seeking → majority vote if consensus fails within 7 days.
   - All votes happen in public GitHub issues.
4. **Code of Conduct**
   Libre WebUI follows the [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) with a dedicated response team.

## 4 Contribution Guidelines (Summary)

- Submit PRs against `dev`; require at least **one approving review** from the TSC.
- All new features must include documentation and unit tests.
- Security issues: disclose privately at **security@kroonen.ai**; we follow a 30‑day coordinated release window.

## 5 Ethical Use & Limitations

Libre WebUI is **tooling**, but we discourage—and will actively oppose—uses that facilitate:

- Human‑rights abuses
- Mass surveillance
- Autonomous lethal weapons

We reserve the right to refuse contributions or sponsorships tied to such activities.

## 6 Enterprise Services

Kroonen AI offers **commercial support and services** for organizations deploying Libre WebUI at scale. Enterprise offerings do not change the open source license—the core product remains Apache 2.0 for everyone.

### Available Services

| Service                    | Description                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| **Custom Deployment**      | On-premise installation, Kubernetes/Docker configuration, and infrastructure optimization |
| **SLA-Backed Support**     | Guaranteed response times, dedicated support channels, and priority issue resolution      |
| **Custom Development**     | Feature development, API integrations, white-labeling, and custom model integrations      |
| **Training & Onboarding**  | Team workshops, documentation customization, and admin training                           |
| **Security & Compliance**  | Security audits, penetration testing, and compliance documentation (GDPR, HIPAA, SOC 2)   |
| **Air-Gapped Deployments** | Fully offline installations for high-security environments                                |

### Compliance-Ready Architecture

Libre WebUI's local-first, zero-telemetry design is inherently suited for regulated industries:

- **GDPR**: No personal data leaves your infrastructure
- **HIPAA**: Zero external data transmission; suitable for PHI workflows with proper deployment
- **SOC 2**: Auditable, self-hosted architecture with full access control
- **FedRAMP/IL environments**: Air-gapped deployment options available

### Contact

**Enterprise inquiries**: enterprise@kroonen.ai
**General support**: hello@kroonen.ai
**Website**: https://kroonen.ai/services

## 7 Amendments

Changes to this charter require:

1. Public proposal (GitHub issue)
2. Discussion period of 14 days
3. **2/3 super‑majority vote** of the TSC

---

_This document is authoritative once merged to the `main` branch and signed by the current TSC._
