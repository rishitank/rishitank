# Rishi Tank

**Senior Full-Stack & AI Engineer · London**

Thirteen years shipping production software. Now building the infrastructure that keeps
autonomous agents contained, verified and affordable — in Rust, Python and TypeScript.

→ **[rishitank.co.uk](https://rishitank.co.uk)** — case studies, a live demo, and an honest
scorecard against the UK NCSC's agentic-AI guidance · [LinkedIn](https://www.linkedin.com/in/rishitank)

## The Robustness Layer

Four components for running agents you cannot fully trust, each answering one question the
others do not trust it to have answered. Built by me; owned and run by
[Tankster AI](https://github.com/TanksterAI), the studio I founded.

| Question | Component | Where |
|---|---|---|
| May this agent act at all, right now, on this target? | Agent OS — the control plane: four gates that always stop for a human, spend posture that tightens as the budget burns, a file-based kill switch | [case study](https://rishitank.co.uk/projects/agent-os) (source private for now) |
| Given permission, what can it actually touch? | **Grit** — policy gateway for MCP tool calls: paths resolved before they are checked, snapshot-and-rollback, AES-256-GCM secrets | [`TanksterAI/grit`](https://github.com/TanksterAI/grit) · [case study](https://rishitank.co.uk/projects/grit) |
| Given that it acted, what left the machine? | **Agent Egress Proxy** — fail-closed perimeter in Rust: PII redaction, per-request cost ceilings, circuit breaker | [`TanksterAI/agent-egress-proxy`](https://github.com/TanksterAI/agent-egress-proxy-clean) · [case study + live demo](https://rishitank.co.uk/projects/agent-egress-proxy) |
| Did containment hold, or did the agent just say it did? | **ADLC** — adversarial verification judged by filesystem state diffs, never by the tool's own output | [`TanksterAI/adlc`](https://github.com/TanksterAI/adlc) · [case study](https://rishitank.co.uk/projects/adlc) |

The whole map, with what each piece honestly is not: [rishitank.co.uk/robustness-layer](https://rishitank.co.uk/robustness-layer).

## Product side project

- [**PreviewProof**](https://preview-proof.lovable.app): paste a URL and see the Google, X, LinkedIn,
  Slack and WhatsApp previews it really produces, with a copy-paste fix for each problem. Built in
  Lovable, then hardened through its GitHub sync: an SSRF-resistant fetcher, 264 unit and 30
  browser tests, and Lighthouse budgets in CI.
  [`rishitank/preview-proof`](https://github.com/rishitank/preview-proof) ·
  [case study](https://rishitank.co.uk/projects/preview-proof)

## Tooling I build for my own work with Claude Code

- [`holocron`](https://github.com/rishitank/holocron) — local codebase intelligence for Claude Code
- [`animawatch`](https://github.com/rishitank/animawatch) — an MCP server that watches web animations like a human tester and reports jank
- [`jdtls-claude-daemon`](https://github.com/rishitank/jdtls-claude-daemon) — persistent Java language-server daemon for Claude Code

## How I work

Structural, not cooperative: a safety property that depends on the agent behaving is a
suggestion. Judge the world, not the agent: the filesystem, the wire and the ledger are the
witnesses. And every README says what the thing is *not* before it says what it does.
