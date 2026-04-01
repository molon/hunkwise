---
name: copilot-review-loop
description: This skill should be used when the user asks to "handle copilot review", "run copilot review loop", "fix copilot issues", "process copilot feedback", "resolve copilot comments", "request copilot review", "address copilot review comments", or says "Copilot 又有新的问题" / "帮我处理 Copilot Review" / "跑一下 Copilot Review". Automatically detects the current PR stage (never reviewed, in-progress, has comments, or clean) and runs the full fix-request-wait loop until Copilot raises no new issues.
---

# Copilot Review Loop

Autonomously run the fix -> request -> wait -> check cycle on a PR until Copilot raises no new issues.

For all `gh api` command snippets, consult **`references/gh-commands.md`**.

## Stage Detection (Always Start Here)

Determine the current PR state before taking any action. Check pending reviewers, review history, and unhandled threads.

**Decision table:**

| State | Action |
|---|---|
| Copilot in `requested_reviewers` | Currently reviewing -> skip to **Wait for Review** |
| Not pending + no reviews ever | Never reviewed -> **Request & Wait** |
| Not pending + reviews exist + 0 unhandled | All clean -> **Done** |
| Not pending + reviews exist + unhandled > 0 | Has open issues -> enter **Fix Loop** |

## The Loop

```
LOOP:
  Step 1 — Find unhandled threads (if none -> Request & Wait)
  Step 2 — Evaluate & proactive scan
  Step 3 — Implement fixes
  Step 4 — Run tests
  Step 5 — Commit and push
  Step 6 — Reply to each comment thread
  Step 7 — Resolve all handled threads

Request & Wait:
  Step 8 — Request Copilot review
  Step 9 — Poll requested_reviewers until Copilot finishes
  -> back to Step 1

  Step 1 finds 0 unhandled -> DONE
```

## Step 1: Find Unhandled Threads

Use GraphQL (NOT REST — REST `in_reply_to_id` misses intra-thread replies).

"Unhandled" = not resolved AND only 1 comment (no reply yet).

See `references/gh-commands.md` for the query. `UNHANDLED: 0` -> proceed to **Request & Wait**.

## Step 2: Evaluate & Proactive Scan

### Evaluate each comment

For each unhandled comment, **before touching code**:

1. Read the full comment body
2. Read the relevant file/function in the codebase
3. Assess: is the suggestion technically correct for this codebase?
4. Decide: fix, push back, or note as already addressed

**Evaluation criteria (be skeptical):**

- Does the suggestion respect the codebase's architectural constraints and intentional design decisions?
- Could it break existing tests or observable behavior?
- Does the reviewer have full context? (e.g., intentional trade-offs, async queue semantics, platform-specific behavior)
- Is this an actual bug, or a misunderstanding of intent?

Push back with technical reasoning when the suggestion is wrong. Do not implement blindly.

### Proactive similar-issue scan

After evaluating a comment, identify the **class of problem** it reveals. Then use understanding of the codebase architecture to find all similar issues — not just the one flagged:

- **Trace the root assumption**: identify what incorrect assumption caused the bug, then locate every other place that assumption appears
- **Follow the data flow**: if a value is mishandled in one function, trace all callers and consumers of that value
- **Verify cross-component consistency**: if two modules must agree on the same logic (e.g., both computing `isDeleted`), verify both sides match
- **Audit related docs and comments**: if one comment is stale due to a code change, check all comments describing the same behavior

This requires deep comprehension of the code, not mechanical grep. Read the relevant modules, understand the invariants, then verify they hold everywhere.

Fix all instances proactively. Group same-class fixes in one commit.

## Step 3: Implement Fixes (TDD)

Follow test-driven development. Invoke the `superpowers:test-driven-development` skill for the full TDD workflow:

1. **Write or update tests first** — add integration/unit tests that cover the expected behavior before implementing the fix. Run them to confirm they fail for the right reason.
2. **Implement the fix** — make minimal, targeted changes per comment.
3. **Run tests** — verify the new tests pass and no existing tests break.

Group same-class fixes together; do not batch unrelated fixes.

## Step 4: Run Tests

Always run unit tests after fixing. Run integration tests when:

- The fix changes observable behavior (not just comments/docs)
- The fix touches state management, file watching, or command logic
- Any doubt about whether it could break an integration scenario

Never commit if tests fail.

## Step 5: Commit and Push

Commit with a descriptive message. Include `Co-Authored-By` with the current model name. Push immediately.

## Step 6: Reply to Each Comment Thread

Reply **inline** using `comments/{id}/replies` (NOT top-level PR comment). Include the commit SHA and a brief description. For pushed-back comments, explain why no change was made.

## Step 7: Resolve All Handled Threads

Resolve all unresolved threads via GraphQL mutation. Only resolve threads that have been addressed.

## Request & Wait

### Step 8: Request Copilot Review

Add `copilot-pull-request-reviewer[bot]` to requested reviewers via `gh api`.

### Step 9: Poll for Completion

**CRITICAL**: Poll the `requested_reviewers` endpoint until Copilot is no longer listed. Do NOT use review count — GitHub sometimes updates an existing review instead of creating a new one, causing count-based polling to hang indefinitely.

Log each poll attempt with timestamp and status. Timeout after 20 attempts (~10 minutes). See `references/gh-commands.md` for the poll script.

After review completes -> back to **Step 1**. If 0 unhandled -> **DONE**.

## Error Handling & Resilience

The loop must never stop due to transient errors. Apply these rules:

- **gh api failures**: Retry up to 3 times with 10-second intervals before giving up on a single API call.
- **Poll timeout**: If polling times out (20 attempts), re-request review and restart the poll — do not stop.
- **Test failures**: Diagnose and fix, then re-run. Never abandon the loop due to a failing test.
- **Commit/push failures**: Check `git status`, resolve conflicts or issues, then retry.
- **Any unexpected error**: Log the error, attempt recovery, and continue the loop. Only stop if the same error persists after 3 retries or if the error is clearly unrecoverable (e.g., repo deleted, auth expired).

The goal is autonomous completion — the user should be able to walk away and find the loop finished.

## Key Rules

- **TDD first** — write or update tests before implementing fixes; confirm they fail, then implement
- **Evaluate before implementing** — read the code first; push back with reasoning when the reviewer is wrong
- **Scan by understanding, not grep** — trace assumptions and data flow to find the same class of bug across the codebase
- **Tests must pass** — never commit broken code; run integration tests for behavioral changes
- **Reply in thread** — use `comments/{id}/replies`, never top-level PR comments
- **Resolve after replying** — only resolve threads already addressed
- **GraphQL for thread detection** — REST misses intra-thread replies
- **Poll `requested_reviewers`, not review count** — prevents stuck loops
- **Never stop on transient errors** — retry API calls, re-request reviews, recover and continue

## References

- **`references/gh-commands.md`** — All `gh api` command snippets: check reviewers, find threads, poll completion, reply, resolve
