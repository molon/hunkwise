---
name: handle-copilot-review
description: This skill should be used when the user says "Copilot 又有新的问题", "handle copilot review", "resolve copilot comments", "process copilot feedback", or asks to handle/fix/resolve Copilot's PR review comments. Automates the full loop: fetch → fix → test → commit → push → reply → resolve → re-request review → wait → repeat, until Copilot raises no new issues.
---

# Handle Copilot PR Review (Full Loop)

Automate the complete cycle of processing Copilot review comments until Copilot is satisfied.

**The loop terminates when:** after re-requesting a Copilot review, no new unhandled comments appear.

## Full Loop

```
LOOP:
  1. Find new unhandled comments
  2. If none → DONE
  3. Evaluate, fix, test, commit, push
  4. Reply to each comment thread
  5. Resolve all handled threads
  6. Record current review count / latest review ID
  7. Re-request Copilot review
  8. Wait for new Copilot review to arrive (poll)
  9. Go to step 1
```

---

## Step 1: Find New Unhandled Comments

Use GraphQL to find review threads with only one comment (i.e. Copilot's comment has no reply yet).
The REST `pulls/{pr}/comments` API does NOT return intra-thread replies reliably — always use GraphQL:

```bash
gh api graphql -f query='
{
  repository(owner: "{owner}", name: "{repo}") {
    pullRequest(number: {pr}) {
      reviewThreads(first: 50) {
        nodes {
          id
          isResolved
          comments(first: 10) {
            totalCount
            nodes { databaseId author { login } body }
          }
        }
      }
    }
  }
}' | python3 -c "
import json, sys
threads = json.load(sys.stdin)['data']['repository']['pullRequest']['reviewThreads']['nodes']
unhandled = []
for t in threads:
    if t['isResolved']:
        continue
    comments = t['comments']['nodes']
    # Unhandled = thread not yet resolved AND no reply (only 1 comment, from Copilot)
    has_reply = t['comments']['totalCount'] > 1
    if not has_reply:
        c = comments[0]
        unhandled.append({'thread_id': t['id'], 'comment_id': c['databaseId'], 'body': c['body']})

print(f'UNHANDLED: {len(unhandled)}')
for u in unhandled:
    print(f'thread={u[\"thread_id\"]} comment_id={u[\"comment_id\"]}')
    print(u['body'])
    print('---')
"
```

If output shows `UNHANDLED: 0` → the loop is **done**.

Identify the PR number and repo from context (git remote, recent commits).

---

## Step 2: Evaluate Each Comment

For each unhandled comment, before touching any code:

1. **Read** the full comment
2. **Read** the relevant file/function in the codebase
3. **Evaluate** technical correctness:
   - Does the suggestion break existing functionality?
   - Is the reviewer missing context?
   - Does it have edge cases not covered?
4. **Decide**: implement, push back with reasoning, or note as already fixed in a later commit

**Common guard pattern bug to watch for:** `foo && foo.bar !== null` silently fails when `foo` is `undefined` (evaluates to `false`, skipping the branch for idle/untracked items not in the map). Use `!(foo && foo.bar === null)` instead to skip only when explicitly known to be null-baseline.

---

## Step 3: Implement Fixes

For each valid comment:

- Read the affected file first
- Make a minimal, targeted change
- Do NOT batch multiple unrelated fixes into one edit

---

## Step 4: Run Tests

```bash
npm test
npm run test:integration
```

If any test fails, diagnose and fix before proceeding. Never commit broken code.

---

## Step 5: Commit and Push

```bash
git add <changed files>
git commit -m "$(cat <<'EOF'
fix: <summary of fixes>

<detail if needed>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
git push
```

---

## Step 6: Reply to Each Comment Thread

Reply inline (NOT as a top-level PR comment):

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies \
  --method POST \
  --field body="Fixed in commit {sha}. <brief description of what changed>"
```

For pushed-back comments: explain why no change was made.

---

## Step 7: Resolve All Handled Threads

```bash
# Get unresolved thread node IDs
gh api graphql -f query='
{
  repository(owner: "{owner}", name: "{repo}") {
    pullRequest(number: {pr}) {
      reviewThreads(first: 30) {
        nodes { id isResolved }
      }
    }
  }
}' | python3 -c "
import json,sys
threads=json.load(sys.stdin)['data']['repository']['pullRequest']['reviewThreads']['nodes']
for t in threads:
    if not t['isResolved']: print(t['id'])
"

# Resolve each
gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \"<id>\"}) { thread { id isResolved } } }"
```

---

## Step 8: Record Latest Review State

Before re-requesting, snapshot the current Copilot review count and latest review ID so we can detect when the new review arrives:

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/reviews | python3 -c "
import json,sys
reviews = json.load(sys.stdin)
copilot = [r for r in reviews if 'copilot' in r['user']['login'].lower()]
print(f'count={len(copilot)} latest_id={copilot[-1][\"id\"] if copilot else 0}')
"
```

---

## Step 9: Re-request Copilot Review

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/requested_reviewers \
  --method POST \
  --field 'reviewers[]=copilot-pull-request-reviewer[bot]'
```

---

## Step 10: Wait for New Copilot Review

Poll every 30 seconds until a new Copilot review appears (count increases or latest ID changes):

```bash
PREV_COUNT=<count from Step 8>
while true; do
  CURRENT=$(gh api repos/{owner}/{repo}/pulls/{pr}/reviews | python3 -c "
import json,sys
reviews=json.load(sys.stdin)
copilot=[r for r in reviews if 'copilot' in r['user']['login'].lower()]
print(len(copilot))
")
  if [ "$CURRENT" -gt "$PREV_COUNT" ]; then
    echo "New Copilot review arrived (count: $PREV_COUNT → $CURRENT)"
    break
  fi
  echo "Waiting... (still $CURRENT reviews)"
  sleep 30
done
```

Typical wait: 1–3 minutes. After 10 minutes with no new review, stop and report to the user.

---

## Key Rules

- **Verify before implementing** — read the code, never trust the reviewer blindly
- **Tests must pass** — never commit if tests fail
- **Reply in thread** — use `comments/{id}/replies`, not top-level PR comments
- **Resolve after replying** — only resolve threads that have been addressed
- **Loop until clean** — re-request and wait after every batch of fixes

## Pushback Pattern

```
"Checked current code — [specific finding]. [Why the suggestion would break X or is already handled]. No change needed."
```

Then resolve the thread.
