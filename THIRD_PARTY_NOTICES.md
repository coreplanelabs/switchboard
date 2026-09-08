# Third-party notices

Switchboard is licensed under the [Apache License 2.0](LICENSE); see also
[NOTICE](NOTICE). It includes or depends on the third-party material below,
each under its own license.

## Vendored agent skills

The skills under `skills/` whose `manifest.yaml` entry names an upstream
source are copied byte-for-byte from
[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills), pinned
to the commit recorded in `skills/manifest.yaml`. They are distributed under
the MIT License:

```
MIT License

Copyright (c) 2025 Addy Osmani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Code of conduct

`CODE_OF_CONDUCT.md` is adapted from the
[Contributor Covenant](https://www.contributor-covenant.org), version 2.1,
licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## npm dependencies

Runtime and build dependencies are declared in the `package.json` files at the
repository root and under `web/`, `docs/`, and `deploy/*/`. Each package
carries its own license in its published tarball. `npm run licenses:check` (at
the root and in `web/`, both run by CI) fails when a production dependency's
license is outside the allowed set. The set, and the documented exceptions for
packages whose manifests misreport their license, live in one place:
[`scripts/licenses-check.mjs`](scripts/licenses-check.mjs). Today the set is
MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0, CC0-1.0,
Unlicense, MPL-2.0, Python-2.0, CC-BY-4.0.

Two entries need a note:

- `lightningcss` (a build-time dependency of the dashboard, via Tailwind) is
  MPL-2.0. It is used unmodified; the MPL's file-level copyleft attaches to
  its own source, not to this project.
- `vaul-vue` (a dashboard component dependency) publishes no `license` field
  in its package manifest, so the checker reports it as unknown. Its
  repository is licensed MIT; the script's exception list says so and skips
  the package by name.
