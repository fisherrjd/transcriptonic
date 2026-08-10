# Local testing

There is no build step. `extension/` is loaded directly as an unpacked Chrome extension.

## Load the extension

1. Go to `chrome://extensions` and switch on **Developer mode** (top right)
2. Click **Load unpacked** and select the `extension/` folder of this repo
3. Click the TranscripTonic icon, tick **Teams (beta)**, and accept the permission prompt Chrome shows

Disable the Chrome Web Store build of TranscripTonic while testing, otherwise two copies race for the same captions.

## After every code change

1. Go to `chrome://extensions` and hit the reload icon on the TranscripTonic card
2. Reload the Teams tab. Content scripts are registered at runtime, so an open tab keeps the old code until refreshed

## Test Teams calls

Teams must run in the browser (`teams.microsoft.com`, `teams.live.com` or `teams.cloud.microsoft`). The desktop app is out of reach for a Chrome extension.

Open DevTools on the Teams tab before starting, so the console log is captured from the beginning.

| Case | Steps | Expected |
| --- | --- | --- |
| Impromptu call | Call someone directly from a chat | Console logs `Meeting started`, then `Found captions container`. Transcript downloads on hangup |
| Scheduled meeting | Join via a meeting link | Same as above, unchanged from before |
| Remote hangup | Call someone, let them end the call | Transcript still downloads, within ~2s of the call UI disappearing |
| Back to back | Finish a call, start another without refreshing | Second call produces its own separate transcript, not an append to the first |

Console lines to expect, in order: `Extension status 200`, `Meeting started`, `Found captions container`, `Captions region detected. Attaching observer...`, `Meeting ended`.

If captions never start, turn them on manually: **More > Language and speech > Turn on live captions**. The auto shortcut is blocked in guest meetings.

## Debugging

- Content script logs: DevTools console on the Teams tab
- Background script logs: `chrome://extensions` > TranscripTonic > **service worker**
- Stored state: DevTools > Application > Storage > Extension storage, or run `chrome.storage.local.get(console.log)` in the service worker console
- Past meetings: the extension popup > **Meetings**, which reads the same storage
