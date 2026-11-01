# EasyRPG Player – WebAssembly build

`index.js` and `index.wasm` are an unmodified Emscripten build of
[EasyRPG Player](https://github.com/EasyRPG/Player), made by the EasyRPG
project's own build server (Jenkins job `toolchain-emscripten`).

- Version string: `0.8 git+437@382767fa (2024-08-25)`
- SHA-256 `index.js`:   `926f7ce230a6dacb8c6f64c7084f40318ae42f926dff7c012fbc4977846a48b5`
- SHA-256 `index.wasm`: `004a68b68d6c426bcb981b422bc1379280566045bfd5c718e89dc26b6547a823`

EasyRPG Player is free software, licensed under the GNU General Public
License v3 or later (see `COPYING`). Its complete source code is available at
<https://github.com/EasyRPG/Player>.

## Updating

Download a newer web build ("Emscripten") from <https://easyrpg.org/player/downloads/>
and replace `index.js` and `index.wasm`. The site only uses the build's documented
interface: the `createEasyRpgPlayer()` factory, the `?game=` URL parameter, the
`games/<game>/index.json` file list and `Module.api`. Newer builds should keep
working, but test a game before you deploy.
