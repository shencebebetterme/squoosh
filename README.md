# [Squoosh]!

[Squoosh] is an image compression web app that reduces image sizes through numerous formats.

# Privacy

Squoosh does not send your image to a server. All image compression processes locally.

However, Squoosh utilizes Google Analytics to collect the following:

- [Basic visitor data](https://support.google.com/analytics/answer/6004245?ref_topic=2919631).
- The before and after image size value.
- If Squoosh PWA, the type of Squoosh installation.
- If Squoosh PWA, the installation time and date.

# Developing

To develop for Squoosh:

1. Clone the repository
1. To install node packages, run:
   ```sh
   npm install
   ```
1. Then build the app by running:
   ```sh
   npm run build
   ```
1. After building, start the development server by running:
   ```sh
   npm run dev
   ```

# Desktop app

This fork also includes a [Tauri](https://tauri.app) desktop shell that packages
the existing static frontend into a standalone executable.

1. Run the desktop app in development mode:
   ```sh
   npm run tauri:dev
   ```
1. Build a standalone desktop executable / installer:
   ```sh
   npm run tauri:build
   ```

# Contributing

Squoosh is an open-source project that appreciates all community involvement. To contribute to the project, follow the [contribute guide](/CONTRIBUTING.md).

Test edit: pushed from the local Codex workspace on 2026-04-27.

[squoosh]: https://squoosh.app
