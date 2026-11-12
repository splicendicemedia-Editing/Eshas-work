# Switching on the realistic AI try-on

The website shows a drawn preview for free. To get the realistic "See it for real" pictures you need two accounts. You create both yourself, because they hold your payment details and your secret key.

## What it costs

- fal.ai charges per picture. With the default model (FASHN Try-On v1.6) that is about $0.075 per picture. One outfit, front and back, is two pictures.
- Each visitor can make 5 pictures a day, so at most about $0.38 per visitor per day.
- Cloudflare Workers is free for this amount of traffic.

Prices were checked on 12 November 2026. Check fal.ai for the current price before you add money.

## Step 1: fal.ai (makes the pictures)

1. Go to https://fal.ai and create an account.
2. Add a small amount of credit, for example $10.
3. Open "API Keys", create a key and copy it. Keep it secret. Do not paste it into the website, GitHub or a chat.

## Step 2: Cloudflare (keeps the key safe)

1. Go to https://dash.cloudflare.com and create a free account.
2. Open "Workers & Pages", choose "Create", then "Create Worker". Name it `miraal-tryon` and deploy it.
3. Choose "Edit code". Delete what is there, paste everything from `tryon-worker.js` in this folder, and deploy.
4. Open the Worker's "Settings", then "Variables and Secrets". Add:
   - `FAL_KEY`, type Secret: paste your fal.ai key.
   - `ALLOWED_ORIGINS`, type Text: `https://splicendicemedia-editing.github.io`
5. For the 5-a-day limit to be enforced on the server: open "Storage & Databases", then "KV", and create a namespace called `miraal-limits`. Back in the Worker's "Settings", under "Bindings", add a KV binding named `LIMITS` that points to it.
6. Copy the Worker's address. It looks like `https://miraal-tryon.YOUR-NAME.workers.dev`.

## Step 3: tell the website

Send that Worker address to whoever maintains the site. It goes in `config.js` as `TRYON_API`. The address is not a secret. After the site is updated, "See it for real" appears in "Try it on me".

## Good to know

- Without step 5 the daily limit is only kept in the visitor's browser, which a determined person can reset. Do step 5 before sharing the link widely.
- To try a cheaper model, add a Text variable `FAL_MODEL` with `fal-ai/image-apps-v2/virtual-try-on` (about $0.04 per picture) or `fal-ai/kling/v1-5/kolors-virtual-try-on` (about $0.07).
- When a visitor taps "See it for real", their photo goes to this server and on to fal.ai. This server does not store photos. Read fal.ai's privacy terms and mention the partner in your privacy policy before a public launch.
- The back picture is the AI's guess, because the outfit pictures only show the front.

## Unstitched fabric

When a visitor brings their own fabric picture and taps "See it for real", the server makes two pictures: first the stitched suit (model `fal-ai/nano-banana/edit`), then the suit on the visitor. That costs roughly 12 to 15 cents instead of about 8, and still counts as one of the visitor's 5 a day. The stitched suit is reused for the back photo, so the back only costs the try-on.

The server also fetches fabric pictures from shop links for the site (`GET ?img=<link>`), because many shops do not let a browser read their pictures directly. It only accepts https picture links, and only from the allowed site.

## Problem log

When something goes wrong for a visitor, the site sends a short text note to this server (never a picture): what failed, where, the phone and browser type, the internet provider and country, and the time. The server also notes its own failures (the AI did not answer, a visitor reached the daily limit). Notes are kept for 60 days in a free Cloudflare D1 database called `miraal-problems`, connected to the Worker as `DB`.

To read them, open `problems.html` on the site and enter your private code. To set the code:

1. In Cloudflare open the Worker `miraal-tryon`, then "Settings", then "Variables and Secrets", then "Add".
2. Type: Secret. Name: `ADMIN_KEY`. Value: a code you choose, at least 8 characters. Do not share it or paste it into a chat.
3. Save and deploy.

Without `ADMIN_KEY` the notes are still stored, but nobody can read them through the page.
