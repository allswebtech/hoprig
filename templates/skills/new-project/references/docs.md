# Documentation

- Applies when: always, as `full`.
- Light form: none. A file or a heading is written only for what the project has (no payments heading without
  payments, the mobile files only with apps).

1. Web repository: `ENVIRONMENT.md` (the environment names from the services reference and what each does),
   `DEPLOYMENT.md` (database, migrations, backup and restore, sign-in, mail, storage, payments, domain and DNS, the
   deployment target, the search consoles), `ASSETS.md`.
2. When other systems call the API: `API.md` or an OpenAPI file built from the schemas, with each endpoint, its auth,
   request and response, error codes, rate limits and examples.
3. Each mobile repository: `CONFIG.md`, `ASSETS.md`, `STORE_SUBMISSION.md` (the steps for both app stores).
4. A command-line tool or a library: a `README.md` with install, every command or the public interface with an
   example, the exit codes or errors, and a `CHANGELOG.md`; how it is published goes into `DEPLOYMENT.md`.
5. Write each fact once and link to it everywhere else.
