# Shoutstr

Write once in Markdown, publish everywhere. **Shoutstr** is a Chrome extension with a built-in editor that sends articles to **Medium**, **Substack**, and **Nostr** — using your browser login for Medium and Substack, no API keys required.

## Features

- Markdown editor with live preview, autosave, and backups
- Publish to Medium, Substack, Nostr, or any combination
- Imports `.md` files with YAML front matter
- Uploads images to each platform before publish

## Quick start

1. Sign in to [Medium](https://medium.com) and/or [Substack](https://substack.com) in Chrome
2. Open Shoutstr, write your article, pick platforms, click **Publish**

For Nostr, add your `nsec` and relays in **Settings** first.

## Platform notes

**Medium** — Uses your logged-in session. Creates a draft, uploads images, and publishes. If rate-limited, the draft is saved and you get the edit URL.

**Substack** — Uses your Substack cookies. Set a publication URL in settings if you have more than one; otherwise it auto-detects.

**Nostr** — `nsec` stays in local storage on your machine. Images go to [nostr.build](https://nostr.build). Default relays are configurable in settings.

## Privacy

Medium and Substack auth uses cookies already in your browser. Your Nostr key is only used to sign events. Drafts are stored locally in the extension.

## License

MIT — see [LICENSE](LICENSE).
