---
name: handle-copilot-review
description: This skill should be used when the user says "Copilot 又有新的问题", "handle copilot review", "resolve copilot comments", "process copilot feedback", or asks to handle/fix/resolve Copilot's PR review comments. Automates the full cycle of fetching new Copilot review comments, verifying and implementing fixes, running tests, committing, pushing, replying, and resolving threads on GitHub.
---

# Handle Copilot PR Review

Automate the full cycle of processing new Copilot review comments on a GitHub PR.

## Workflow

Execute the steps below in order. Do not skip steps.

### Step 1: Fetch New Comments

Fetch all top-level review comments from the PR and identify ones not yet responded to:

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments | python3 -c "
import json, sys
comments = json.load(sys.stdin)
top_level = [c for c in comments if 'in_reply_to_id' not in c]
# New = no existing reply in the list
replied_to = {c.get('in_reply_to_id') for c in comments if 'in_reply_to_id' in c}
new_ones = [c for c in top_level if c['id'] not in replied_to]
for c in new_ones:
    print(f'id={c[\"id\"]} path={c[\"path\"]}')
    print(c['body'])
    print('---')
"
```

Identify the PR number and repo from context (git remote, recent commits, or ask the user).

### Step 2: Evaluate Each Comment (Before Implementing)

For each new comment, apply the receiving-code-review protocol:

1. **Read** the full comment body
2. **Verify** against the current codebase — read the relevant file/function before deciding
3. **Evaluate** technical correctness:
   - Does the suggestion break existing functionality?
   - Is reviewer missing context about this codebase?
   - Does the suggestion have edge cases not covered?
4. **Decide**: implement, push back with technical reasoning, or note as already fixed

Common edge case to watch for: guards like `foo && foo.bar !== null` silently fail when `foo` is `undefined` — use `!(foo && foo.bar === null)` instead when idle/untracked items (not in map) must still be processed.

### Step 3: Implement Fixes

For each valid comment, implement the fix:

- Read the affected file first
- Make a minimal, targeted change
- Do NOT batch multiple unrelated fixes into one edit

### Step 4: Run Tests

After implementing all fixes, run both test suites:

```bash
npm test
npm run test:integration
```

If any test fails, diagnose and fix before proceeding. Do not commit broken code.

### Step 5: Commit and Push

Commit with a descriptive message referencing what was fixed:

```bash
git add <changed files>
git commit -m "fix: <summary of fixes>

<detail if needed>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push
```

### Step 6: Reply to Each Comment Thread

Reply inline to each comment thread (NOT as a top-level PR comment):

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies \
  --method POST \
  --field body="Fixed in commit {sha}. <brief description of what changed>"
```

For pushed-back comments (technically incorrect), reply explaining why no change was made.

### Step 7: Resolve All Threads

Get thread node IDs via GraphQL, then resolve each:

```bash
# Get thread node IDs
gh api graphql -f query='
{
  repository(owner: "{owner}", name: "{repo}") {
    pullRequest(number: {pr}) {
      reviewThreads(first: 30) {
        nodes { id isResolved comments(first:1) { nodes { databaseId } } }
      }
    }
  }
}'

# Resolve each unresolved thread
gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \"<id>\"}) { thread { id isResolved } } }"
```

Only resolve threads for comments that have been handled (fixed or pushed back with reply).

## Key Rules

- **Verify before implementing** — read the code, don't trust the reviewer blindly
- **One fix at a time** — implement and mentally verify each comment independently
- **Tests must pass** — never commit if tests fail
- **Reply in thread** — use `comments/{id}/replies`, not top-level PR comments
- **Resolve after replying** — resolve only threads that have been addressed

## Pushback Pattern

When a suggestion is technically incorrect:

```
Reply: "Checked current code — [specific finding]. [Why the suggestion would break X or is already handled]. No change needed."
```

Then resolve the thread.

## Identifying New Comments

A comment is "new" (unhandled) if it has no reply in the comment list. Use the fetch script in Step 1 to identify these reliably — do not rely on memory from previous sessions.
