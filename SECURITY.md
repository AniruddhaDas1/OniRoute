# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

---

## Reporting a Vulnerability

We take the security of OniRoute and sensitive user API keys seriously. If you discover a security vulnerability, please follow these steps:

1. **Do NOT disclose the issue publicly** in GitHub issues or discussions.
2. Email your findings directly to **[contact@leadspree.in](mailto:contact@leadspree.in)**.
3. Include detailed steps to reproduce the vulnerability, sample payloads, and affected components.

### Our Commitment
- We will acknowledge receipt of your vulnerability report within 48 hours.
- We will provide an estimated timeline for remediation and keep you informed of our progress.
- Once fixed, a security advisory will be published and credit will be given (unless requested otherwise).

---

## Security Best Practices for Self-Hosters

- **Port 1001 Local Server**: When exposing OniRoute over public networks, always enforce HTTPS via Cloudflare Tunnel or a reverse proxy (e.g. Caddy, Nginx).
- **Master Key Security**: Protect your `./data/.secret_key` or `ONIROUTE_SECRET` environment variable.
- **Gateway Keys**: Create distinct `or_...` keys for individual clients/users and revoke keys immediately upon credential compromise.
