# Audio credits

## adhan-madinah.mp3, adhan-madinah.ogg

- Title: "Call to Prayer from the Prophet's Mosque" (recorded at Masjid an-Nabawi, Madinah;
  the muezzin is not named)
- Source: https://commons.wikimedia.org/wiki/File:33937_ejaz215_call-to-prayer-from-the-prophet-s-mo.ogg
- Author: Freesound user ejaz215 (Freesound sound #33937, 2007), imported to Wikimedia Commons
- License: Creative Commons Attribution 3.0 Unported (CC BY 3.0),
  https://creativecommons.org/licenses/by/3.0/
- Required attribution: "Call to Prayer from the Prophet's Mosque" by ejaz215 (Freesound),
  via Wikimedia Commons, CC BY 3.0.
- Files: `adhan-madinah.ogg` is the Wikimedia Commons original (Ogg Vorbis, 128 kbps, 3:07),
  unmodified. `adhan-madinah.mp3` is a 128 kbps MP3 encoded from that file for iOS Safari;
  the recording itself was not edited.
- The author asked that the sample not be used in musical productions; it is used here only
  as the prayer-time call to prayer.

The file names include "madinah" so service workers that cached the previous recording
fetch the new one. The tasbih click sounds are generated in the browser with the Web Audio API
and are not recordings.

## notify-jingle.m4a, notify-jingle.wav

- Original signature notification jingle of Al Muttaqin Cultural Center: a short motif in
  maqam Hijaz on D (D, E flat, F sharp, G, A, B flat), a plucked qanun-like string
  (Karplus-Strong synthesis), a soft daf, and a low D drone.
- Composed and synthesised from scratch by `scripts/generate-notification-assets.mjs`
  (deterministic, no samples or third-party recordings), so there is no external license.
- Re-generate with `node scripts/generate-notification-assets.mjs` (the `.m4a` needs macOS
  `afconvert` or `ffmpeg`; the `.wav` is the universal fallback).
