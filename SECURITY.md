# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use GitHub's [private vulnerability reporting](https://github.com/kamoras/stream-tools/security/advisories/new) feature instead. This keeps the details confidential until a fix is available.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce
- Any suggested fix if you have one

You can expect an acknowledgement within 48 hours and a resolution or status update within 7 days.

## Scope

Areas of particular concern for this project:

- The onboarding endpoint (`POST /onboard`) — invite code bypass or brute-force
- Secrets leaking via logs or error responses
- Dependency vulnerabilities (please check if a CVE already exists before reporting)

## Out of Scope

- Issues that require physical access to the server
- Social engineering attacks
- Vulnerabilities in Twitch's own platform
