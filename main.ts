// Shadowline — make.fun program/v1 entrypoint (Node 22, standard library only).
//
// The grader runs this with no arguments as `node main.ts`. It copies the
// playable game (game/) and its screenshots (screenshots/) from beside this
// file into the output directory and writes dossier.json there, the summary
// the judge reads, built with the vendored make.fun library.
//
//   MAKEFUN_OUTPUT_DIR=out node main.ts
//
// The run is deterministic: same input files, same output bytes.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(outDir, { recursive: true });
cpSync(join(here, 'game'), join(outDir, 'game'), { recursive: true });
mkdirSync(join(outDir, 'screenshots'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) {
  cpSync(join(here, 'screenshots'), join(outDir, 'screenshots'), { recursive: true });
}

// Caps the scorer applies (from the vendored library's documentation): at most
// 4 screenshots of 256 KiB each, 993 entries / 48 MiB under game/, and a
// dossier text of 160 KiB. Passing them here makes this program fail exactly
// where the scorer would refuse the entry.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);
