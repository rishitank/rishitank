# Open-source list: how it stays in sync

The **Open source** section of this README and the list on
[rishitank.co.uk/about](https://rishitank.co.uk/about) are the same data:
[`data/open-source.json`](../data/open-source.json). Nothing else is edited by hand.

```
                      weekly (Mon 06:17 UTC) or on demand
                                   │
            ┌──────────────────────▼──────────────────────┐
            │ scan (no AI)                                 │
            │  discover.mjs: GitHub search for every issue │
            │  and PR I opened outside my own accounts,    │
            │  compared with data/open-source-ledger.json  │
            │  verify-claims.mjs: is every claim still     │
            │  true?                                       │
            └──────────────┬───────────────────────────────┘
               nothing new │ something new, changed or no longer true
                   (stop)  ▼
            ┌──────────────────────────────────────────────┐
            │ curate (Claude, read-only GitHub access)     │
            │  reads each thread, applies the rules below, │
            │  edits only the two data files               │
            └──────────────┬───────────────────────────────┘
                           ▼
            ┌──────────────────────────────────────────────┐
            │ review (a second Claude, fresh context)      │
            │  re-reads the sources for every change;      │
            │  verdict: approve or needs-human-review      │
            └──────────────┬───────────────────────────────┘
                           ▼
            ┌──────────────────────────────────────────────┐
            │ publish (no AI)                              │
            │  fresh checkout; takes only the two data     │
            │  files; regenerates README; runs tests,      │
            │  validation and verify-claims; opens a PR    │
            └──────────────┬───────────────────────────────┘
                           ▼
         ci-gate + CodeRabbit approval → auto-merge (review approved)
         or label needs-human-review (anything flagged)
                           ▼
        README updated on merge; the portfolio picks up the JSON within an hour
```

## What qualifies

An item goes in only with a **clear, checkable connection** between something I
did and something that shipped or merged:

1. **A pull request I opened** that was merged, or is open and under review
   (said as "in review", never "merged").
2. **An issue or discussion I opened** that a maintainer resolved with
   - a merged PR or a commit that cites it ("Fixes #N", "Resolves #N", "fix #N"), or
   - an explicit statement in the thread that it shipped ("released in 1.2.3",
     "added in 2.3.0"), for projects whose code is not public.
3. **A comment of mine** that the maintainer explicitly credited when closing
   the issue (the MCP TypeScript SDK entry is the only one today).

Each entry's `status` says which, and validation checks that the evidence
supports it **and shows my part in it**:

| status | needs evidence of |
|---|---|
| `merged` | a pull request I opened, merged |
| `in-review` | a pull request I opened, still open |
| `shipped` | an issue or discussion I opened, and its resolution: a fixing PR or commit, a release, a file such as a changelog, or a maintainer saying so |
| `credited` | a comment of mine, and someone else's comment crediting it |

So an entry can never be about work that has nothing to do with me, however
true its claims are.

The weekly scan **discovers** only issues and pull requests I opened. Comments
and discussions still qualify, but have to be added by hand (or by asking the
curator in a manual run).

Not enough on its own: an issue closed as "completed" with no comment; a
changelog line that matches my request but does not cite it; a stale-bot
closure; a question that was answered; a fix for something that was my own
configuration. These go in the ledger as `excluded`, with the reason.

## Wording

- One or two sentences, ideally under 50 words, first person, past tense, British spelling.
- Say exactly what happened: "requested", "reported", "merged", "shipped in 1.2.3".
  Never "contributed" or "built" for code someone else wrote.
- "Merged" is not "released". Only name a version when a release or maintainer says so.
- Link the issue and/or PR numbers at the end in brackets.
- Only `` `code` `` and `[label](https://github.com/...)` markup is allowed, and
  links may only point at a GitHub repository, issue, PR, discussion, release
  or commit. Plain text may not contain `< > * _ ~ & @ ! \`, bare URLs or line
  breaks. The validator enforces this so the README and the website render the
  same and nothing can inject HTML, images or mentions.

## Evidence

Every entry lists evidence that `scripts/oss/verify-claims.mjs` re-checks
against the GitHub API on every PR and every week:

| type | proves |
|---|---|
| `issue` | the issue exists, `author` opened it, and optionally that its title/description contains `contains` |
| `pr` | the PR exists, `author` opened it, its `merged` / `state`, and optionally its target branch (`base`) and that its title/description contains `contains` |
| `pr-fixes-issue` | the PR merged and its title/body closes `#issue` (which the same entry must show I opened) |
| `comment` | `author` wrote a comment on the thread containing `contains` |
| `commit` | the commit's message contains `contains` |
| `release` | the release `tag`'s notes contain `contains` |
| `file` | a file in the repo contains `contains` (e.g. a changelog) |
| `discussion-answer` | the discussion's chosen answer is by `author` and contains `contains`, and optionally that `opener` opened the discussion |

Quotes are matched exactly; one that ends in a number must not run on into a
longer one (`fixes #59` does not match `fixes #595`).

`watch` asks the weekly scan to report when a release mentions something (for
example `#2869`), so "merged" can become "shipped in vX" without anyone remembering.

## Running it by hand

```sh
node --test tests/*.test.mjs                  # unit tests, no network
node scripts/oss/validate.mjs                 # data + ledger shape and agreement
node scripts/oss/render-readme.mjs            # regenerate the README block
GITHUB_TOKEN=... node scripts/oss/verify-claims.mjs     # exit 1: a claim is false; exit 2: could not check
GITHUB_TOKEN=... node scripts/oss/discover.mjs --out discovery.json
```

Or run the **open-source-discover** workflow from the Actions tab.

## One-time setup

Two repository secrets (Settings → Secrets and variables → Actions):

- `CLAUDE_CODE_OAUTH_TOKEN`: run `claude setup-token` locally (needs a Pro or
  Max plan) and paste the token. Runs count toward the plan's usage.
- `OSS_PR_TOKEN`: a fine-grained personal access token for **this repository
  only**, with **Contents** and **Pull requests** read and write. Pull requests
  opened with the built-in `GITHUB_TOKEN` do not trigger CI, so the gate would
  never run.

Security notes:

- The agents get a read-only, job-scoped token and run with secrets scrubbed
  from their subprocesses. They can read files only inside the checkout (with
  explicit denies for `/proc`, where their own environment holds the Claude
  token, and the runner's temp folder), edit only the two data files and
  their summary, and run only the four commands named in the workflow.
- The publish step, which has no AI, refuses a ledger whose `user`,
  `excludeOwners` or `$comment` changed or that lost an item, and refuses
  anything model-written (data, summary, verdict) that looks like a credential.
- Model-written text goes into the PR description inside a code fence, capped
  in length, so it cannot mention people or close issues.

Auto-merge relies on the account policy in `rishitank/.github` (the
`review-gate` and `ci-gate` rulesets and "Allow auto-merge"). Until that is in
place the workflow still opens the PR, just without arming auto-merge.
