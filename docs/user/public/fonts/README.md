# Documentation fonts

These unmodified Latin-subset WOFF2 files are the Inter and IBM Plex Mono faces previously downloaded by the documentation theme. Keeping them in the repository makes documentation builds independent of font-provider availability.

- [Inter](https://github.com/google/fonts/tree/main/ofl/inter): normal and italic variable fonts. Copyright 2020 The Inter Project Authors. See [Inter's OFL](./inter/OFL.txt).
- [IBM Plex Mono](https://github.com/google/fonts/tree/main/ofl/ibmplexmono): normal and italic faces at weights 400, 500, and 600. Copyright © 2017 IBM Corp., with Reserved Font Name "Plex". See [IBM Plex Mono's OFL](./ibm-plex-mono/OFL.txt).

The licenses ship with the website under `/fonts/`. The SDK package does not include these documentation assets.

The Blume configuration reads Inter's weight range from the font files. An explicit local range such as `400..700` passes Blume's validation but reaches generated CSS unchanged, where it is invalid.

CI preloads `scripts/block-documentation-fetch.ts` while building the documentation. Any attempted fetch fails the build, even if a dependency catches the exception. Keep replacement fonts local and retain their licenses.
