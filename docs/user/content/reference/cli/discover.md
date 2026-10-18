---
title: corven-email discover
description: List public entrypoints from the installed package manifest without discovering accounts.
---

```sh
corven-email discover
```

The report contains the package name, version and sorted public entrypoints. It excludes the manifest convenience subpath from the entrypoint inventory and marks provider capabilities unchecked and submission not attempted.

## Use the installed inventory

Use this command when an application cannot import a documented entrypoint or may be using a different installed version. Match imports to the package's actual exports rather than reaching into private `dist/` files.

Discovery reads bounded installed distribution metadata. Invalid or unavailable metadata fails safely; it does not search credential files, environment variables or provider accounts.

This is a packaging check, not local message preflight or an account health check. Use [providers](/reference/cli/providers) for implemented inspection profiles and [validate](/reference/cli/validate) for request checks.
