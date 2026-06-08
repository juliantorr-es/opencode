# OMP Prompt Snippet: Exit Output Contract

Every agent execution session must end with a structured output report matching the following shape. Do not output conversational filler after this report.

```markdown
## Execution Outcome

- **Status**: [SUCCESS | FAILED | STOPPED]
- **Reason**: [Detailed explanation of completion, failure, or trigger that stopped execution]

### 1. Files Mutated
- [ ] List each file path updated along with its:
  - Expected pre-SHA-256
  - Actual post-SHA-256
  - Associated transaction receipt ID (relational mutation record)

### 2. Verification & Tests Run
- **Test Command**: `[command executed]`
- **Results**: [X pass, Y fail, Z total]
- **Unrelated Suite Status**: [CLEAN | BLOCKED_BY_FAILURES]

### 3. Paired Packet Status
- **Regenerated**: [YES | NO]
- **Target Snapshot ID**: `[snapshot hash]`
- **Bundle File Count**: [Exact number of artifacts; must be 10 JSONs if Gemini structured IR]

### 4. Remaining Findings & Next Steps
- **Unresolved Findings in 10_review_findings.json**: [Count or summary]
- **Next Safe Action**: [Specific step for the next agent in the queue]
```
