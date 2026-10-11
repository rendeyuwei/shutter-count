# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `rendeyuwei/shutter-count`.
Use the authenticated `gh` CLI from this clone, or pass
`--repo rendeyuwei/shutter-count` explicitly.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels`; add label or state filters as needed.
- Comment: `gh issue comment <number> --body-file <file>`.
- Add or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.
- For multiline bodies, save the exact text to a temporary file with a quoted heredoc and use `--body-file`.
- Sub-issues: use `gh api --method POST repos/rendeyuwei/shutter-count/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`. Obtain the database ID with `gh api repos/rendeyuwei/shutter-count/issues/<child> --jq .id`. If unavailable, add the child to a task list in the parent and put `Part of #<parent>` at the top of the child body.

## Pull requests as a triage surface

**PRs as a request surface: no.**

If enabled later, use the equivalent `gh pr` commands to read, comment,
label, and close external PRs. Inspect changes with `gh pr diff <number>`.
Issues and PRs share a number space; resolve the resource type before acting.

## Skill operations

- "Publish to the issue tracker": create a GitHub issue.
- "Fetch the relevant ticket": read the referenced GitHub issue.

## Wayfinding operations

Used by `/wayfinder`.

- Map: one issue labelled `wayfinder:map`, with Notes / Decisions-so-far / Fog in its body.
- Child: a sub-issue of the map, labelled `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`). Use the task-list fallback above if sub-issues are unavailable.
- Blocking: use native issue dependencies: `gh api --method POST repos/rendeyuwei/shutter-count/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Obtain the blocker's database ID with `gh api repos/rendeyuwei/shutter-count/issues/<blocker> --jq .id`. If unavailable, put `Blocked by: #<number>` at the top of the child body.
- Frontier: inspect the map's open children in map order; choose the first unassigned child with no open blockers. Use `issue_dependencies_summary.blocked_by` or resolve each fallback blocker.
- Claim: assign the ticket to the driving developer with `gh issue edit <number> --add-assignee @me` before starting work.
- Resolve: comment with the answer, close the child, and append a gist and link to the map's Decisions-so-far.
