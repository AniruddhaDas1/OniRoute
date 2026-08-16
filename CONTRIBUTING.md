# Contributing to OniRoute

Thank you for your interest in contributing to OniRoute! We welcome contributions from the community to help make OniRoute the fastest, most reliable, and easiest-to-host AI Gateway.

---

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## How to Contribute

### 1. Reporting Bugs
- Search the [GitHub Issues](https://github.com/AniruddhaDas1/OniRoute/issues) first to see if the issue has already been reported.
- If not, open a new issue with a clear title, description, steps to reproduce, and environment details (Node version, OS, standalone vs Supabase).

### 2. Suggesting Features
- Open a feature request issue explaining the motivation, use case, and proposed architecture/API change.

### 3. Submitting Pull Requests
1. **Fork the repository** on GitHub.
2. **Clone your fork**:
   ```bash
   git clone https://github.com/<your-username>/OniRoute.git
   cd OniRoute
   ```
3. **Create a feature branch**:
   ```bash
   git checkout -b feat/your-feature-name
   ```
4. **Install dependencies**:
   ```bash
   npm install
   ```
5. **Make your changes and verify**:
   ```bash
   # Run local test suite
   npm run test:local

   # Run TypeScript and linter verification
   npm run verify
   ```
6. **Commit with descriptive messages** following Conventional Commits (`feat: ...`, `fix: ...`, `docs: ...`).
7. **Push to your fork and submit a Pull Request** against the `main` branch.

---

## Development Guidelines

- **Architecture First**: Keep the standalone local server (`server/`) lightweight with zero mandatory external binaries.
- **Provider Protocol Normalization**: When adding support for new upstream LLM providers, normalize requests in both `server/provider-client.mjs` and `supabase/functions/_shared/provider-client.ts`.
- **Security**: Never expose upstream API keys or decrypted vault secrets to client-facing responses or logs.

---

## Powered By

OniRoute is actively maintained by **Aniruddha Das** and powered by **[Leadspree Business Solutions](https://leadspree.in)**.
