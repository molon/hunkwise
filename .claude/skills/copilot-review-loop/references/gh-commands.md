# GitHub CLI Commands Reference

All commands for interacting with Copilot PR reviews via `gh api`.

**Obtaining `{owner}`, `{repo}`, `{pr}`**: Derive from `gh pr view --json number,headRepository` or from the current branch context (e.g., `gh pr list --head $(git branch --show-current)`).

## Check Pending Reviewers

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/requested_reviewers | python3 -c "
import json,sys
d=json.load(sys.stdin)
logins=[u['login'].lower() for u in d.get('users',[])]
print('pending_copilot=YES' if any('copilot' in l for l in logins) else 'pending_copilot=NO')
"
```

## Count Copilot Reviews

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/reviews | python3 -c "
import json,sys
reviews=json.load(sys.stdin)
copilot=[r for r in reviews if 'copilot' in r['user']['login'].lower()]
print(f'review_count={len(copilot)}')
if copilot: print(f'latest_id={copilot[-1][\"id\"]} latest_at={copilot[-1][\"submitted_at\"]}')
"
```

## Find Unhandled Threads (GraphQL)

Use GraphQL, NOT REST. REST `in_reply_to_id` misses intra-thread replies. See SKILL.md Step 1 for the definition of "unhandled".

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
            nodes { databaseId body }
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
    if t['comments']['totalCount'] == 1:
        c = t['comments']['nodes'][0]
        unhandled.append({'thread_id': t['id'], 'comment_id': c['databaseId'], 'body': c['body']})
print(f'UNHANDLED: {len(unhandled)}')
for u in unhandled:
    print(f'thread={u[\"thread_id\"]} comment_id={u[\"comment_id\"]}')
    print(u['body'])
    print('---')
"
```

## Request Copilot Review

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/requested_reviewers \
  --method POST \
  --field 'reviewers[]=copilot-pull-request-reviewer[bot]'
```

## Poll for Review Completion

**CRITICAL**: Poll `requested_reviewers` becoming empty, NOT review count. GitHub sometimes updates an existing review instead of creating a new one, causing count-based polling to hang indefinitely.

```bash
attempt=0
max_attempts=20
while [ $attempt -lt $max_attempts ]; do
  result=$(gh api repos/{owner}/{repo}/pulls/{pr}/requested_reviewers | python3 -c "
import json,sys
d=json.load(sys.stdin)
logins=[u['login'].lower() for u in d.get('users',[])]
has_copilot = any('copilot' in l for l in logins)
print('pending_copilot=YES' if has_copilot else 'pending_copilot=NO')
")
  echo "$(date '+%H:%M:%S') attempt=$((attempt+1))/$max_attempts $result"
  if echo "$result" | grep -q 'pending_copilot=NO'; then
    echo "Copilot review completed"
    break
  fi
  attempt=$((attempt + 1))
  sleep 30
done
if [ $attempt -ge $max_attempts ]; then
  echo "Timeout after $max_attempts attempts"
fi
```

Typical wait: 1-5 minutes. After 10 minutes (20 attempts), stop and report to user.

## Reply to Comment Thread

Reply inline, NOT as top-level PR comment:

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies \
  --method POST \
  --field body="Fixed in {sha}. <brief description>"
```

## Get Unresolved Thread IDs

```bash
gh api graphql -f query='
{
  repository(owner: "{owner}", name: "{repo}") {
    pullRequest(number: {pr}) {
      reviewThreads(first: 50) {
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
```

## Resolve a Thread

```bash
gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \"<id>\"}) { thread { id isResolved } } }"
```
