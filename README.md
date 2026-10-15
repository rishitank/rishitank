# Rishi Tank

**Senior Full-Stack & AI Engineer · London**

Thirteen years shipping production software, most recently as web tech lead at Adthena. Now designing
the infrastructure that keeps autonomous agents contained, verified and affordable, and building it by
directing AI coding agents.

→ **[rishitank.co.uk](https://rishitank.co.uk)** — case studies, a live demo, and an honest
scorecard against the UK NCSC's agentic-AI guidance · [LinkedIn](https://www.linkedin.com/in/rishitank)

## The Robustness Layer

Four components for running agents you cannot fully trust, each answering one question the
others do not trust it to have answered. Designed by me and built by directing AI coding agents;
owned and run by [Tankster AI](https://github.com/TanksterAI), the studio I founded.

| Question | Component | Where |
|---|---|---|
| May this agent act at all, right now, on this target? | Agent OS — the control plane: four gates that always stop for a human, spend posture that tightens as the budget burns, a file-based kill switch | [case study](https://rishitank.co.uk/projects/agent-os) (source private for now) |
| Given permission, what can it actually touch? | **Grit** — policy gateway for MCP tool calls: paths resolved before they are checked, snapshot-and-rollback, AES-256-GCM secrets | [`TanksterAI/grit`](https://github.com/TanksterAI/grit) · [case study](https://rishitank.co.uk/projects/grit) |
| Given that it acted, what left the machine? | **Agent Egress Proxy** — fail-closed perimeter in Rust: PII redaction, per-request cost ceilings, circuit breaker | [case study + live demo](https://rishitank.co.uk/projects/agent-egress-proxy) (source private for now) |
| Did containment hold, or did the agent just say it did? | **ADLC** — adversarial verification judged by filesystem state diffs, never by the tool's own output | [`TanksterAI/adlc`](https://github.com/TanksterAI/adlc) · [case study](https://rishitank.co.uk/projects/adlc) |

The whole map, with what each piece honestly is not: [rishitank.co.uk/robustness-layer](https://rishitank.co.uk/robustness-layer).

## Side projects

- **News Brief**: when the switch to Gemini broke Google's spoken news briefing on my phone, I rebuilt
  it on my own Google Cloud. A Cloud Run job stitches the short bulletins I choose into one spoken brief
  that skips editions I've already played, published as a private podcast that I listen to daily. Each show
  has a fallback chain, builds that change nothing publish nothing, and deploys are keyless through
  Workload Identity Federation. Designed by me, built by directing AI coding agents; source private for now.
  [case study](https://rishitank.co.uk/projects/news-brief)
- [**PreviewProof**](https://preview-proof.lovable.app): paste a URL and see the Google, X, LinkedIn,
  Slack and WhatsApp previews it really produces, with a copy-paste fix for each problem. Built in
  Lovable, then hardened through its GitHub sync: an SSRF-resistant fetcher, unit and
  browser test suites, and Lighthouse budgets in CI.
  [`rishitank/preview-proof`](https://github.com/rishitank/preview-proof) ·
  [case study](https://rishitank.co.uk/projects/preview-proof)

## Tooling I build for my own work with Claude Code

- [`holocron`](https://github.com/rishitank/holocron) — local codebase intelligence for Claude Code
- [`animawatch`](https://github.com/rishitank/animawatch) — an MCP server that watches web animations like a human tester and reports jank
- [`jdtls-claude-daemon`](https://github.com/rishitank/jdtls-claude-daemon) — persistent Java language-server daemon for Claude Code

## Open source

<!-- open-source:start -->
<!-- Generated from data/open-source.json by scripts/oss/render-readme.mjs. Edit the JSON, not this block. -->

Upstream issues, proposals and fixes, each backed by a linked issue or pull request:

- **Redoc**: built XML and CSV response examples for Adthena's API docs, first proposed in 2023 ([#2347](https://github.com/Redocly/redoc/pull/2347)) and later backed by another developer. CSV support is merged for the next release ([#2869](https://github.com/Redocly/redoc/pull/2869)); my XML fixes to openapi-sampler await review ([#223](https://github.com/Redocly/openapi-sampler/pull/223))
- **claude-code-lsps**: had a Java language-server (jdtls) reliability fix merged ([#73](https://github.com/Piebald-AI/claude-code-lsps/pull/73)); my request led to Scala (Metals) support ([#54](https://github.com/Piebald-AI/claude-code-lsps/issues/54)), and my diagnosis of why it would not load got it fixed ([#56](https://github.com/Piebald-AI/claude-code-lsps/issues/56))
- **GitHub Copilot CLI**: proposed repo-specific MCP configs, shipped as the repeatable `--additional-mcp-config` flag ([#288](https://github.com/github/copilot-cli/issues/288))
- **MCP TypeScript SDK**: my `docker run --init` workaround for orphaned MCP containers was credited by the maintainer when closing the issue ([#547](https://github.com/modelcontextprotocol/typescript-sdk/issues/547))
- **VibeTunnel**: requested Auggie CLI support, added in v1.0.0-beta.16 and credited to me in its release notes ([#526](https://github.com/amantus-ai/vibetunnel/issues/526), [#680](https://github.com/amantus-ai/vibetunnel/pull/680))
- **coolify-mcp**: reported that updating an application's domain failed because the server sent `fqdn` where the Coolify API now expects `domains`; the owner closed it as fixed by a later pull request ([#110](https://github.com/StuMason/coolify-mcp/issues/110), [#125](https://github.com/StuMason/coolify-mcp/pull/125))
- **Auggie CLI**: reported a response-delay regression in v0.6.0 and tested the maintainers' prerelease fix, shipped as 0.6.1 ([#28](https://github.com/augmentcode/auggie/issues/28)); a maintainer said my request for native shell support should be fixed in the latest release ([#14](https://github.com/augmentcode/auggie/issues/14))
- **DBCode**: requested Redshift Spectrum support, shipped in 1.14.24, then reported a regression in that release, fixed in 1.14.25 ([#613](https://github.com/dbcodeio/public/issues/613), [#644](https://github.com/dbcodeio/public/issues/644))
- **stylelint-stylistic**: reported styled-components indentation bugs, fixed in v3.1 and v3.1.1 ([#39](https://github.com/stylelint-stylistic/stylelint-stylistic/issues/39))
- **eslint-plugin-project-structure**: requested a kebab-case `{parentName}` reference and `jest.mock` import checks; the maintainer shipped them in 2.3.0 and 2.7.0 ([#14](https://github.com/Igorkowalski94/eslint-plugin-project-structure/issues/14), [#18](https://github.com/Igorkowalski94/eslint-plugin-project-structure/discussions/18))
- **branch-name-lint**: asked for JavaScript config files, which the maintainer added in a pull request that fixes my issue ([#51](https://github.com/barzik/branch-name-lint/issues/51), [#66](https://github.com/barzik/branch-name-lint/pull/66))
- **Tagify**: reported a stray `&nbsp;` added with every tag, fixed by a maintainer commit that cites my issue ([#595](https://github.com/yairEO/tagify/issues/595))
- **yajs.vim**: reported two JavaScript and JSX highlighting bugs, both fixed by commits that cite my issues ([#168](https://github.com/othree/yajs.vim/issues/168), [#169](https://github.com/othree/yajs.vim/issues/169))
- **ng-embed**: asked for a way to switch off HTML sanitising, added as an option by a pull request that resolves my issue ([#39](https://github.com/ritz078/ng-embed/issues/39), [#53](https://github.com/ritz078/ng-embed/pull/53))

<!-- open-source:end -->

## How I work

Structural, not cooperative: a safety property that depends on the agent behaving is a
suggestion. Judge the world, not the agent: the filesystem, the wire and the ledger are the
witnesses. And every README says what the thing is *not* before it says what it does.
