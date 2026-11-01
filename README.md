# Amethyst · EasyRPG Web Player

A website for playing **RPG Maker 2000 and 2003** games in the browser, powered by
[EasyRPG Player](https://easyrpg.org/player/) compiled to WebAssembly.

- **Import any game.** Drop a game ZIP or folder on the page, or pick it with the buttons. ZIPs with Japanese, Korean, Chinese or Cyrillic file names work too.
- **Everything stays local.** Games, saves and settings live in the browser's IndexedDB. Nothing is uploaded, and the site needs no server-side code.
- **Saves.** In-game saves persist automatically. From the library you can export them as a ZIP, import them (including `SaveXX.lsd` files from the PC version) or delete them.
- **RTP support.** Import your RPG Maker 2000/2003 RTP once. Games that need it then use it automatically, and EasyRPG's RTP name table makes games built for the Japanese RTP work with the English one, and the other way round.
- **Better MIDI.** Add a `.sf2` SoundFont once and every game uses it.
- **Works on phones and tablets.** There's an on-screen D-pad with A/B/Shift buttons, and gamepads and keyboard work too. The player page also has fullscreen, screenshot, settings (F1) and reset buttons.
- **Hosted games.** Site owners can publish games in `games/` so visitors can play them without importing anything. A free demo (the EasyRPG TestGame for RPG Maker 2003) is included.

## Running it

The site is static, so any static web host works: GitHub Pages, Netlify, Cloudflare Pages, nginx and so on. It must be served over **https://** (or `http://localhost`), because browsers only allow the storage it needs in secure contexts. Opening `index.html` straight from disk (`file://`) does not work.

**GitHub Pages:** Settings → Pages → *Deploy from a branch* → pick the branch and `/ (root)`.

**Locally:**

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

## Publishing games on the site (optional)

1. Copy a game folder to `games/<id>/`. The folder must contain `RPG_RT.ldb` and `RPG_RT.lmt` at its top level. `<id>` becomes part of the URL (`play.html?game=<id>`), so use lowercase letters, digits, `-` or `_`.
2. Run the indexer (Node.js 18 or newer):

   ```bash
   node tools/gencache.mjs
   ```

   It writes `games/<id>/index.json` (the file list the player needs, the same format as EasyRPG's `gencache` tool) and updates `games/games.json`, the list shown under *Games on this site*. You can edit `title` and `description` in `games/games.json`; later runs keep your changes.
3. Commit and deploy.

To remove the demo, delete `games/easyrpg-testgame-2003/` and run `node tools/gencache.mjs` again.

Only publish games you have the right to distribute.

## How it works

The official EasyRPG web build fetches game files on demand from `games/<game>/…` using an `index.json` file list. For games imported into the browser, `play.html` builds that `index.json` on the fly, then answers the player's requests from IndexedDB through a small `XMLHttpRequest` wrapper (`js/xhr-shim.js`). The player binary itself is unmodified.

| Path | Purpose |
| --- | --- |
| `index.html`, `js/library.js` | Library: import, game list, saves, RTP and SoundFont |
| `play.html`, `js/play.js` | Player page: loading, toolbar, touch controls, error reporting |
| `js/importer.js` | Reads ZIPs and folders, detects games / RTP / SoundFonts, stores files |
| `js/zip.js` | ZIP reader (streams from disk, ZIP64, legacy file name encodings) and writer |
| `js/gamefs.js` | Builds `index.json` and resolves player requests, with RTP fallback |
| `js/xhr-shim.js` | Serves game files to the player from IndexedDB |
| `js/saves.js` | Reads and writes EasyRPG's save storage (IDBFS) |
| `js/rtp-table.json` | RTP file name table, converted from EasyRPG's `src/rtp_table.cpp` |
| `player/` | EasyRPG Player WebAssembly build (see `player/README.md`) |
| `tools/gencache.mjs` | Indexer for hosted games |

## Browser support

The site supports current Chrome, Edge, Firefox and Safari on desktop and mobile. It needs WebAssembly and IndexedDB. Some private-browsing modes block IndexedDB; use a normal window in that case.

## Licenses

- EasyRPG Player (`player/`) is © the EasyRPG Project, licensed under the GNU GPL v3 (`player/COPYING`). Source code: <https://github.com/EasyRPG/Player>.
- fflate (`js/vendor/fflate.min.js`) is MIT-licensed (`js/vendor/fflate.LICENSE`).
- The demo game in `games/easyrpg-testgame-2003/` is the EasyRPG TestGame, licensed under the GNU GPL v3, with assets under CC BY 4.0 and other free licenses. See the `COPYING` and `AUTHORS.md` files in that folder.
- RPG Maker is a trademark of Gotcha Gotcha Games / KADOKAWA. This project is not affiliated with them or with the EasyRPG project.
