// Site settings for the realistic AI try-on.
//
// TRYON_API is the web address of the small Miraal server (see server/README.md) that holds the
// fal.ai key and makes the try-on pictures. It is NOT a secret. Leave it empty until that server
// exists: "Try it on me" then shows the drawn preview only and nothing is uploaded.
export const TRYON_API = 'https://miraal-tryon.belle-preview-dist.workers.dev/';

// Free realistic try-on pictures per visitor per day (the server enforces the same number).
export const DAILY_LIMIT = 5;

// Name shown to visitors in the consent text.
export const TRYON_PARTNER = 'fal.ai';
