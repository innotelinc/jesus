---
description: How to respond to GitHub issues with insufficient information
---

# GitHub Issue Triage — Requesting More Information

When analyzing a GitHub issue and the provided information is insufficient to diagnose or implement a fix, follow these steps:

## 1. Identify Missing Information

Check if the issue contains:

- [ ] Clear description of the problem or feature
- [ ] Steps to reproduce (for bugs)
- [ ] Error messages / logs
- [ ] Environment details (OS, version, deployment method)
- [ ] Expected vs actual behavior
- [ ] Screenshots (if UI-related)

## 2. Draft a Response (in English)

Use this template structure, adapting to what's specifically missing:

```markdown
Thanks for reporting this issue! 🙏

To help us investigate and fix this, could you please provide some more details?

1. **Environment**: What OS are you running? How did you install OmniRoute (npm global, Docker, from source)?
2. **Steps to Reproduce**: What exact steps lead to this issue?
3. **Error Logs**: Can you share the full server logs? (Check the terminal or `logs/application/app.log`)
4. **Expected vs Actual**: What did you expect to happen, and what actually happened?
5. **Screenshots**: If this is a UI issue, a screenshot would be very helpful.

This information will help us reproduce and fix the issue more quickly. Thank you!
```

## 3. Adapt the Template

- Remove items that are already provided in the issue
- Add domain-specific questions based on the issue type:
  - **OAuth/Auth issues**: Ask for provider name, auth flow used, token errors
  - **Multi-account issues**: Ask how many accounts, which providers, dashboard screenshots
  - **Startup/crash issues**: Ask for full startup logs, OS version, Node.js version
  - **UI rendering issues**: Ask for browser name, screen resolution, screenshots
  - **API issues**: Ask for request/response examples, curl commands used

## 4. Post the Response

// turbo
Post the response as a comment on the GitHub issue using the GitHub CLI:

```bash
gh issue comment <ISSUE_NUMBER> --repo diegosouzapw/OmniRoute --body "<RESPONSE_BODY>"
```

If `gh` CLI is not available, provide the response text to the user to post manually.

## 5. Add Labels (optional)

If applicable, add a `needs-info` label:

```bash
gh issue edit <ISSUE_NUMBER> --repo diegosouzapw/OmniRoute --add-label "needs-info"
```
